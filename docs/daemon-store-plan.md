# Project data moves into the daemon

Working plan for moving sessions, tasks and everything hanging off them out of the app's SQLite
database and into `maestro-server`. Written to be updated in place, in the manner of
`automations-plan.md`: each phase records the decisions that are locked.

**Before starting any phase, ask as many questions as needed to eliminate doubt.** One phase at a
time, with review in between.

## Where it is going

The acceptance test is one sentence. Maestro on machine A connects to an SSH host, opens a project,
starts a few sessions and leaves without closing them. Maestro on machine B connects to the same
host as the same OS user, opens the same project, and finds the same board, the same tasks and the
same sessions.

Today that fails twice. The list of open sessions is in `.maestro/state.json`, written by the app
and keyed by ids from A's database. And tasks exist only in A's database, so B's board is empty.

```
   app A ─┐                                      ┌─ sessions, mid-turn or dormant
          ├─attach─▶ maestro-server daemon ──────┼─ tasks, comments, reviews, worktrees
   app B ─┘          (owns project data)         └─ automations (already here)
```

The app keeps what belongs to the user or to the machine the app runs on. The daemon keeps what
belongs to a project.

## Decisions that span every phase

- **A project is its canonicalized path**, resolved by the daemon. Same rule as automations and
  project locks. The app's `projects.id` never crosses the wire.
- **One store, not two.** No copy of project data stays app-side as a backup. A database on disk
  already survives a daemon crash, a stop and a version replace, and two stores is what produced the
  double-restore guard in `restore_acp_session`.
- **Local projects take the same path.** The local daemon lives in `<MAESTRO_DATA_DIR>/daemon/`, so
  there is no second code path for "normal" projects.
- **Same OS user on the remote, by design.** The daemon lives in `~/.maestro/daemon/`, so two users
  on one host have two daemons and share nothing.
- **The project lock still decides who drives.** One window holds a project at a time, so there is
  never a second writer to reconcile with. B opening a project A holds is a takeover, as today.

## What moves, and what stays

| Table                                              | Goes to | Why                                                           |
| -------------------------------------------------- | ------- | ------------------------------------------------------------- |
| `tasks`, `task_relationships`, `task_instructions` | daemon  | Project data                                                  |
| `task_comments`, `task_attachments`                | daemon  | Project data; the file is copied into the project on attach   |
| `task_reviews`, `review_comments`                  | daemon  | Project data                                                  |
| `worktrees`                                        | daemon  | Rows describe directories on the daemon's machine             |
| `session_aliases`                                  | daemon  | A renamed session must keep its name on B                     |
| sessions (new)                                     | daemon  | Replaces `restorable_sessions` and `SessionHostMeta`          |
| `projects`, `ssh_connections`, `wsl_connections`   | app     | How this app reaches a machine                                |
| project prompts, and their favorite flag           | daemon  | The project's collection, so B sees it                        |
| `connection_settings`                              | daemon  | A machine's agent limit has to hold across every app using it |
| `docker_connections`, `known_hosts`                | app     | How this app reaches a machine                                |
| `settings`, `templates`                            | app     | The user's, on every connection                               |
| shared prompts, and their favorite flag            | app     | The user's, on every connection                               |

## Phases

| Phase | What                                               | State       |
| ----- | -------------------------------------------------- | ----------- |
| 0     | Request ids on the wire                            | Done        |
| 1     | Sessions: the daemon knows what a project has open | Done        |
| 2     | Tasks, their threads, worktrees and reviews        | In progress |
| 3     | Project prompts                                    | Not started |
| 4     | Import what apps already hold, then drop it        | Not started |
| 5     | The pipeline runs with no window                   | Not started |

### Phase 0: request ids on the wire

The host matches replies by type, not by request id. Each request type has one slot in
`PendingChannels`, and a second request of that type while the first is outstanding fails with
"already in progress". That holds for a handful of settings calls. It does not hold for a board,
where the frontend fires a dozen task queries at once.

Every request carries an id and its reply echoes it. `query_via_server` keeps a map of waiting
senders keyed by that id instead of one slot per type. This is a `PROTOCOL_VERSION` bump, and the
only one the plan should need if later phases add message variants in the same release window.

Nothing user-visible changes. It lands first because every later phase multiplies the traffic.

Decisions:

| Topic            | Decision                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the id is  | An optional top-level `rpc_id` key on the frame, beside `direction` and `type`. The enums are untouched. Not `id` or `request_id`, which payloads flattened into the same object already use |
| Who gets one     | Sessionless replies only. A session-scoped message is already routed by its session id                                                                                                       |
| Events           | Never stamped. `ServerResponse::is_reply` is an exhaustive match, so a new variant has to choose                                                                                             |
| Server           | The sink handed to `dispatch_message` is per request and carries the id, so a spawned task's clone does too                                                                                  |
| Host             | One map per connection from id to waiting sender replaces the 35 typed slots                                                                                                                 |
| Errors           | An `Error` with an id fails that request. The guess chain over the slots is deleted                                                                                                          |
| Left type-routed | `TakeoverResultOk`, written by a timer or by another client's answer, with no request to echo                                                                                                |

Tasks:

- [x] T1 `maestro-protocol`: the frame id, `encode_message` / `decode_message`, `is_reply`, version 8
- [x] T2 `maestro-server`: carry the id from ingress to egress
- [x] T3 `src-tauri`: the id map, `query_via_server`, the reader, and the four slot users outside it
- [x] T4 Whole-workspace check, an independent review, and
      `test_sessionless_reply_echoes_request_id` against the real server binary
- [ ] A run of the app against a live daemon, which no test here replaces

What the review found:

- The frame key was first `id`, which collides with `Automation.id` and `AutomationRun.id`. Every
  `AutomationRunChanged` push failed to decode and was skipped silently, and `SaveAutomation` timed
  out on the host after saving on the daemon. Renamed to `rpc_id`, and the round-trip samples now
  include a payload with each of the two taken names.
- A caller that registered after the reader had ended waited out its whole timeout. `fail_all` now
  closes the map, so a late registration fails at once.
- Latent, not fixed: the session command loop sends `Error` with no `session_id` through the sink
  of the request that created the session (`command_loop.rs`). Harmless while `Spawn` and
  `SessionLoad` are sent without an id. If either ever gets one, those errors go out under a dead
  id and the host drops them. Set `session_id` on them first.

Found and left alone: several request arms await something slow inline on the daemon's main loop
(`PreInitialize`, `FileSearch`, `CheckTools`, `InstallSkills`, the two agent detections). Ids make
concurrent requests correct, not parallel: a board query still waits behind one of those. Worth its
own look before phase 2.

### Phase 1: sessions

A `sessions` table in a new `projects.db` beside `automations.db`, one row per conversation a
project has ever held, open or closed.

| Column                                                             | Note                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `agent_id`, `acp_session_id`                                       | The key. The routing id changes on every reload, so it cannot be |
| `project_path`                                                     | Canonical, what B asks by                                        |
| `cwd`                                                              | What `session/load` needs, and what Session History reopens in   |
| `session_name`                                                     | The user's name for it. Replaces `session_aliases`               |
| `task_id`, `task_name`, `branch_name`, `role`, `session_start_sha` | Were in `SessionHostMeta`, now columns                           |
| `can_reload`                                                       | Recorded at spawn, as `runs.can_reload` is                       |
| `session_id`                                                       | The live routing id, null while the session is dormant           |
| `created_at`, `closed_at`                                          | `closed_at` null means the project still has it open             |

Decisions:

| Topic                           | Decision                                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dormant sessions                | Stay open until somebody closes them. No expiry                                                                                                                                                                                                           |
| What closes a row               | A user close and a pipeline close (superseded coder, finished planner) alike: `Cancel`                                                                                                                                                                    |
| What does not                   | The idle sweep, the agent dying, the daemon stopping, an update, a window going away                                                                                                                                                                      |
| An agent without `session/load` | Its session is closed when it is reaped or its agent dies, since it can never come back                                                                                                                                                                   |
| Takeover                        | B adopts A's sessions, mid-turn ones included. A is already sent to the picker                                                                                                                                                                            |
| Stop server, update             | Rows stay, so the sessions reload afterwards                                                                                                                                                                                                              |
| Closed rows                     | Kept, because Session History needs the name and folder of a closed session. Dropped 90 days after `closed_at`, and when the agent deletes the session                                                                                                    |
| Task ids                        | Stored as the host sends them. They are the app's until phase 2 and the daemon's after. Nothing is built to bridge the gap, since nothing ships between phases. Until then a second machine's pipeline acts on the first machine's task ids as they stand |
| Metadata on reload              | The daemon keeps what the row already holds, so a reload that sends less does not lose role, start sha or task name, which every reload path loses today                                                                                                  |
| The idle sweep                  | Still global: any window attached keeps every session alive. Left as it is                                                                                                                                                                                |

What it replaces:

- `SessionHostMeta` and `host_meta`. `SpawnRequest` and `SessionLoadRequest` carry the project path
  and a typed `SessionMeta`. `project_id` and `connection_key` are gone from the wire: B works out
  both from the connection it asked on and its own `projects` row for that path.
- `ListLiveSessions`, by `ListProjectSessions { project_path }`, which returns every row with the
  live state of the ones that are running. The app adopts the live ones and loads the dormant ones,
  which is what `adopt_live_sessions` and `spawn_session_restores` do today from two sources.
- `restorable_sessions` and `session_folders` in `.maestro/state.json`, with
  `save_current_sessions_for_project` and its seven call sites.
- `session_aliases` in the app's database. A rename is `RenameSession`, written to the row.
- The special case in `adopt_live_sessions` that invents metadata for an automation's session from
  the `runs` table: an automation's session gets a row like any other.
- `restore_acp_sessions` on SSH reconnect, which sends `session/load` under new ids against a
  daemon that may still hold those sessions. Reconnect becomes the same query as opening.

Rows the apps already hold (`state.json`, `session_aliases`) are imported in phase 4.

Tasks:

- [x] T1 `maestro-protocol`: `SessionMeta`, `ProjectSession`, `ListProjectSessions`, `RenameSession`,
      added beside what they replace so the tree keeps compiling
- [x] T2 `maestro-server`: `projects.db`, the row's lifecycle, the two new requests
- [x] T3 `src-tauri` and the frontend: open, reconnect, history, rename and recovery read the daemon
- [x] T4 Remove `host_meta`, `ListLiveSessions` and the state-file code; docs; review; end-to-end test

Not in this phase: a transcript for the part of a turn nobody watched. A session adopted mid-turn
still starts its transcript at the reconnect. A daemon-side replay buffer fixes that and is its own
piece of work.

### Phase 2: tasks, their threads, worktrees and reviews

`tasks`, `task_relationships`, `task_instructions`, `task_comments`, `task_attachments`,
`worktrees`, `task_reviews` and `review_comments` move to `projects.db`, with `project_path` where
`project_id` was. Worktrees and reviews were phase 3, and moved here because every one of them has
a foreign key or a JOIN into `tasks` (merge, review, the zombie sweep, the worktree list): moving
tasks alone meant writing cross-store glue for phase 3 to delete.

- The SQL moves with them. `task/crud.rs`, `task/transition.rs`, `task/comments.rs` and their
  siblings become daemon modules, and the app's commands become one round trip each, the shape
  `project/automations.rs` already has.
- **A guarded step is one request.** Every `transition::apply_if_*` reads, then writes, and is
  atomic today only because every command shares the app's one `Mutex<Connection>`. In the daemon
  each is a single request run under the store's lock: the guard travels with the transition. The
  same goes for the composite steps the pipeline runs under one lock today: the turn end (phase
  read, review round count, transition, `record_outcome`), `close_refinement` and
  `request_task_execution`.
- Every change is broadcast as `TasksChanged { project_path }`, and a thread change as
  `TaskCommentsChanged`, which is what refetches a second window and replaces the app's own 32
  `tasks-changed` emits. A worktree or review change is broadcast the same way.
- The task tools of the MCP server (`create_task`, `list_tasks`, `get_task`, `update_task`,
  `comment_task`) are answered by the gateway itself, from the session's `project_path` and
  `task_id`. They stop needing a window. `create_task` reads `.maestro/settings.json` and the
  current branch locally, since the daemon is on the project's machine.
- Diff, merge, staging and remote stay in the app, tunnelled as they are. Only the rows move.
- `adopt_automation_worktrees` goes away: the daemon writes the row when it makes the worktree.
- Issue sync, pull request polling, `execution/queue.rs` and the in-memory task holds stay in the
  app until phase 5. They write through the same requests as everything else.

Decisions:

| Topic                       | Decision                                                                                                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task ids                    | Per project: the key is `(project_path, id)`. Each project has a counter that never goes back, so a deleted task's number is never reused while its `task-<id>` folder or `maestro/<id>-` branch may linger. Phase 4 imports ids as they are, so existing folders and branches still match their task |
| Ids on the app side         | Every command naming a task carries `project_id` too, and every task query key in the frontend carries the project, since two projects both have a task 3                                                                                                                                             |
| Attachments                 | Copied on attach into `<project>/.maestro/attachments/tasks/<task_id>/` on the daemon's machine, through the copy path prompts already use. The row holds a project-relative path, so every machine and every agent sees the file. The app stops reading sizes off its own disk                       |
| Daemon unreachable          | The board shows the connection error and a retry. No cache, no queued writes                                                                                                                                                                                                                          |
| Two windows editing a field | Last write wins. There is no position column, and the daemon's lock settles transition races                                                                                                                                                                                                          |
| Agent writes with no window | Allowed. The broadcast reaches nobody, and a window refetches when it opens the project                                                                                                                                                                                                               |
| Schema                      | `projects.db` gets `PRAGMA user_version` and a migration step, which phase 1 did without                                                                                                                                                                                                              |

Tasks:

- [x] T0 Slow daemon arms answer off the main loop, so a board query does not wait behind a skills
      install (`f30ebea7`). `RunAutomation` still runs `git worktree add` inline
- [x] T1 `maestro-protocol`: row types, the transition event and its guard, the requests, the
      pushes; `PROTOCOL_VERSION` 9
- [x] T2 `maestro-server` store for tasks and threads: schema, migration, per-project counter,
      `transition` rules and guards moved with their tests
- [x] T3 `maestro-server` store for worktrees and reviews
- [ ] T4 `maestro-server` dispatch: the arms, the composite steps, the broadcasts
- [ ] T5 `maestro-server` MCP task tools answered by the gateway
- [ ] T6 `src-tauri` task commands as round trips, with `project_id`; pushes become events
- [ ] T7 `src-tauri` pipeline, worktree and review sites: `reader_task`, `merge`, `review`, `queue`,
      `spawn`, the session and prompt handlers, `worktree_lifecycle`, `worktree_query`
- [ ] T8 Attachments copied on attach
- [ ] T9 Frontend: `projectId` on commands and query keys, bindings
- [ ] T10 Remove the app's task SQL (the tables stay until phase 4), docs, review, an end-to-end
      test with two clients seeing `TasksChanged`

### Phase 3: project prompts

**Prompts are two collections, and nothing syncs.** A project's collection is in its daemon, so
every app opening the project sees it. The shared collection is in the app's database, as today, so
it is there in every project that app opens. The two are separate stores with separate rows.

- **Moving between them is a copy.** Today the share button flips `project_id` on one row. After
  this phase it writes a new row in the other collection and leaves the original where it was. The
  two copies have no link: editing or deleting one does nothing to the other.
- That copy is how a prompt reaches another machine. Copy it into the project, the app on machine B
  sees it there, and B's user copies it into B's shared collection if they want it elsewhere.
- **The page shows the two collections apart**, each under its own heading with a line saying
  where it is stored and who sees it. Favorites sort first inside each, so the Favorites and Others
  sections go, and the filter shrinks to All and Favorites.
- **The two collections sit side by side, in two columns**, each scrolling on its own, the way the
  board's columns do. Stacked, a long project collection pushes the shared one below the fold and a
  drag has to auto-scroll to reach it; side by side a drag is always a short sideways move. A copy
  lands at the top of its column, after the favorites. The width below which the columns stack
  again is a question for the start of this phase.
- **Copying is a drag or a menu item.** Dragging a card onto the other collection copies it there:
  the target lights up and says a drop copies, and the original stays. "Copy to shared" or "Copy to
  this project" is the first item of the card's menu, which is the path for the keyboard and for
  anyone who does not guess the drag. The card carries no share icon any more. `@dnd-kit` is already
  in the app for the board. An empty collection still draws, so it can be dropped on.
- Copying twice makes two rows. Nothing deduplicates.
- **A favorite is a column on the row, in both collections.** A project prompt's is in the daemon,
  so it is starred for every app opening the project. A shared prompt's is in the app, and stars it
  in every project that app opens. `prompt_favorites`, which made a shared prompt's star per
  project, is dropped.
- The prompt tools of the MCP server name a prompt by collection and id, `project-3` or `shared-3`,
  the way template ids are `user-3` or `builtin-name`, because two stores mint ids independently.
  `update_prompt` loses its `shared` argument, which meant a move. The gateway answers for the
  project's collection and forwards to the host for the shared one, so with no window attached an
  agent sees the project's only.

### Phase 4: import, then drop

On opening a project, an app that still holds rows for it sends them to the daemon once, in one
transaction, and marks the project imported. Task ids are kept as they are, since they are per
project and the daemon holds none for it yet, and the project's counter starts above the highest.
A task id is embedded in things that outlive the row: the `task-<id>` worktree folder, the
`maestro/<id>-` branch and a commit message template. Keeping ids keeps those matching.

- The app's tables stay, unread, for one release, then a schema migration drops them.
- Attachment rows whose file is on this app's disk are copied into the project on the way in.

### Phase 5: the pipeline runs with no window

After phase 3 the daemon holds every row the pipeline reads and writes, and the app still drives it:
a turn ends, the app classifies it, applies the transition, and starts the next stage. Close the
window and a task stops where it is. This phase moves the driver, so a task goes from queue to
coder to reviewer to a pull request with every window closed, the way an automation already runs.

What moves, in the order it can land:

| Step | What                                                   | From                                        |
| ---- | ------------------------------------------------------ | ------------------------------------------- |
| 5a   | The scheduler: who runs next, and how many at once     | `execution/queue.rs`, `connection_settings` |
| 5b   | Starting a task's session, worktree included           | `useExecuteTask` and the spawn handlers     |
| 5c   | Reading a turn end, and handing over to the next stage | `acp/completion.rs`, `acp/reader_task.rs`   |
| 5d   | Merging, opening the pull request, and watching its CI | `git/merge.rs`, `integration/pull_request*` |
| 5e   | Issue sync                                             | `integration/issue_sync.rs`                 |

- **5a.** `connection_settings` becomes a daemon setting, because the limit is the machine's. Today
  two apps on one host each count only their own agents, so the limit is per app by accident.
- **5b.** The daemon already starts sessions and makes worktrees for automations
  (`automation_runner.rs`, `worktree.rs`). A task's run is the same spawn with a task behind it
  instead of a run row. Agent profiles are in `.maestro/`, which the daemon reads directly.
- **5c.** `classify_turn` and `classify_verdict` are pure and move as they are. Turn ends already
  reach the daemon's main loop through `TURN_TX`, which is how a run ends. The checks that need git
  (did the repository change) become local `git` in the daemon.
- **5d.** Merge is local `git` on the machine the daemon is on. Opening a pull request and polling
  its CI need the forge token, which stays in the app's keychain and is pushed into the daemon's
  memory after every preflight, the way `SetMcpSecrets` works. A daemon restarted with no window has
  none: tasks waiting on a forge wait until an app connects, and everything else keeps moving.
- **5e.** Same token rule as 5d.

What the window is for after this: showing the board, answering permission prompts and questions,
and the gates a human owns (plan approval, review approval). A task blocked on one of those waits,
as a session blocked on a permission prompt already does.

What stays in the app: diff and staging for the review screen, tunnelled as today. Moving those is
a simplification this phase makes possible, not something it needs.

The project lock changes meaning here. It no longer decides who drives the pipeline, only which
window may edit the board.

## Decisions taken during planning

- **The daemon drives, not only stores.** Phase 5 is in scope.
- **Project prompts move to the daemon.** Shared prompts stay in the app.
- **No offline board.** A project does not open without its daemon, so nothing is lost.
- **Import is first app in.** If the daemon already holds tasks for a project, a second app's rows
  for it are not imported. No user is in that position today, so nothing merges and nothing
  deduplicates.
- **Forge work pauses with no token.** After a daemon restart, pull request and CI steps wait until
  an app connects and pushes the token. Nothing is written to the daemon's disk.
- **A permission prompt waits for a user.** An unattended task runs in the permission mode it was
  given and blocks on a prompt until someone attaches.
- **Prompts are copied between collections, never synced.** A mesh of stores reconciling shared
  prompts across every daemon and app was designed and dropped: it needed stable ids, newest-wins
  and permanent tombstones to make a removal stick. See phase 3.

## Open questions

None.
