# maestro-server

Notes for working in this directory. The repository-wide rules are in the root `AGENTS.md`. Report diagnostics with `helpers::send_diag`, never `eprintln!`; the reason is under Rust
logging in `src-tauri/AGENTS.md`.

## The resident maestro-server

`maestro-server` is a daemon, one per machine, distro or container, and the app never spawns it
directly. Every transport spawns `maestro-server attach` instead, a byte relay from its own stdin
and stdout to the daemon's loopback socket:

```
app ──spawns child──▶ maestro-server attach ──TCP loopback + token──▶ maestro-server daemon
                      (dies with the app)                             (resident)
```

This is why agent sessions survive the window closing, and why the four transport functions in
`transport_setup.rs` did not change shape to get it: the relay speaks the same framed stdio the
server always did. `attach` starts the daemon when none is running, so no caller has to know
whether one is.

**The lock, not the runtime file, says whether a daemon is alive.** `<dir>/lock` is held open for
the daemon's whole life, so the OS releases it on death; `<dir>/runtime.json` carries
`{port, token, version, protocol_version, pid}` and is left behind by a crash, pointing at a dead
port. The directory is `<MAESTRO_DATA_DIR>/daemon/` locally — so a dev build gets its own daemon
rather than contending with the installed app — and `~/.maestro/daemon/` on a remote machine,
passed through `MAESTRO_DAEMON_DIR`.

A daemon whose `version` or `protocol_version` differs from the connecting client is replaced, but
only silently when nothing would be lost. `attach` first asks it over a plain-text `STATUS` line,
answered with one `DaemonActivity` JSON line: a window attached, or any session mid-turn (which
covers a pending permission prompt and a running automation), makes it busy, and so does no answer
within two seconds. A busy daemon is left alone and `attach` answers the app's handshake with a
`SERVER_BUSY_ERROR`, which the preflight modal turns into an **Update anyway** button;
`attach --replace` (from `preflight_connection`'s `replace`, one spawn only) skips the question.
Retiring is a plain-text `SHUTDOWN` line. Both lines are read before any framing so they work
across protocol versions, and every connection is served on its own task so both are answered
while another window is attached. **A retired daemon's sessions die with it**, and remote daemons
are not version-namespaced, so a dev build and a released app pointed at the same SSH host keep
asking to replace each other's.

Deploy replaces the binary before `attach` decides anything: `rm` on Unix, where the running image
keeps its inode, and a rename to `.old` on native Windows, which refuses to delete a running
executable but allows renaming one.

`ClientSink` (`maestro-server/src/client_sink.rs`) is what made this possible without touching a
dozen signatures: every response leaves through `helpers::send_response`, so swapping the
destination is one indirection. A write with no client attached succeeds and drops the bytes —
nobody watching is the normal state of a daemon between app runs, not an error.

**Every window attaches at once.** Each window numbers its own requests from 1, so an id says
which request a reply answers and nothing about which window sent it. The sink routes: a reply
goes to the window that asked, a message naming a session goes to that session's owner (the
window that last sent a request naming it), and anything unowned or unprompted goes to every
window. A window receiving a session it does not hold parks it, and answers a `HostToolCall` only
for a session it holds, so two windows never both answer one call.

**A reply is matched by id, a session message by its session.** A frame may carry an `rpc_id`
beside `direction` and `type`. The host stamps one on every sessionless request and keeps a map
from id to waiter per connection (`PendingRequests`); the server echoes it on a reply that is
sessionless and answers a request (`ServerResponse::is_reply`), and on nothing else. So an
`Error` fails exactly the request it answers, and two requests of one type can be outstanding at
once. The key is `rpc_id` because the message is flattened into the same object and payloads
already own `id` and `request_id`. `TakeoverResultOk` is the one reply still matched by type: a
timer or another window's answer writes it, and neither knows the id that asked.

**A project's sessions are rows in the daemon.** `maestro-server/src/project_store.rs` keeps a
`sessions` table in `projects.db`, beside `automations.db`: one row per conversation a project has
opened, keyed by `agent_id` and the agent's own session id, because the routing id is minted again
on every reload and cannot name a conversation across them. `SpawnRequest` and `SessionLoadRequest`
carry the project path and a typed `SessionMeta` (name, task, branch, role, start sha), each field
its own column, so a second machine opening the project can read them and a reload that sends
fewer keeps what the row already holds. A closed row reopened from Session History is a new use of
the conversation and takes the meta it is reopened with whole, so it does not come back bound to
its old task. A close that lands while a load is in flight stays closed: the load's own write
leaves a row closed after it was asked for. The row is written where the session enters the daemon's
map, the `spawn_result_rx` arm of `main.rs`, and an automation's session gets one like any other.
Nothing about open sessions is kept app-side: not in `.maestro/state.json`, and a session's name
is `RenameSession` on the row rather than the app's `session_aliases` table.

**`projects.db` migrates by `user_version`.** `MIGRATIONS` in `project_store.rs` is an append-only
list, one frozen literal per version, and each step runs in its own transaction with the version it
reaches. A daemon refuses a file at a version newer than it knows, as the app refuses a newer
database. A remote daemon directory, `~/.maestro/daemon/`, is shared by every build on that host,
dev and released alike, so a dev build that migrated it leaves an older daemon there without its
store until that one is updated. That is accepted, as it is for the app database.

**Opening a project is one question.** `session_ops::attach_project_sessions` sends
`ListProjectSessions`, which answers with every row and, for the ones whose routing id the
session map still holds, their live state. `row_action` then decides per row: a session mid-turn
is adopted as it stands under the id the daemon files it under, one between turns is closed and
loaded back, and a dormant one is loaded. It runs from `prime_project_server`, from the SSH
reconnect and from task recovery alike, so none of them can load a conversation the daemon is
already running. A row this window already holds is skipped, and holding it means an entry under
the routing id the row is live under, or a load of a dormant row still in flight from here. An
entry under any other id is stale, left by a window that lost the project to another which then
reloaded the session, and is dropped before the row is adopted or loaded. `ProjectKicked` drops the
kicked project's entries too, without closing anything, because the sessions are the new holder's.

With no store, `ListProjectSessions` answers from the session map: the project's running sessions,
open, and nothing dormant, which the daemon cannot know of without it.

**A session between turns is closed and reloaded**, which is the only way to recover the
transcript it produced while nobody was attached: the agent keeps its own history, and
`session/load` is what replays it. `LiveSessionState.turn_active` is what decides, since closing a
session mid-turn throws the turn away, so those are adopted as they are and their transcript
begins at the reconnect. Do **not** issue `session/load` against a live session without closing it
first: `maestro-server` would replace its own map entry while the displaced command loop kept
running, leaving an agent nothing routes to and nothing stops.

**Only a close closes a row.** `Cancel` sets `closed_at`, whether a user or the pipeline sent it,
and `tear_down_session` follows it with `CloseProjectSession` by key, because `Cancel` finds the row
only through a session the daemon still runs under that id: not one whose load never came up, nor
one the sweep already made dormant. The daemon refuses that close while a live command loop runs
under the key, so after a `Cancel` that did close the row it changes nothing. The idle sweep, a
dead agent, a stopped daemon and an update only clear the routing id, so the session is dormant and
loads again the next time the project is opened. Two exceptions close on going dormant: an agent
without `session/load`, whose session can never come back, and the session of a finished
automation run, which is read from its run card and reopened from there. That second one is closed
when the sweep reaps it, when it is closed in the app, and at daemon startup for every finished run,
so a joined run's session follows the same rule and a run in progress is never touched. Closed rows
stay for 90 days, because Session History needs their name and folder.

**A load that can never succeed closes its row too.** A dormant row has no routing id for `Cancel`
to find, so left alone it would be loaded again on every open. The daemon marks a load failure as
final with `SESSION_GONE_ERROR`, a longer spelling of `SESSION_LOAD_FAILED_ERROR`, when the agent
answers that it has no such conversation, the folder is gone while the project folder is still
there, or the agent is unknown on that machine. A missing project folder is a drive or mount that
is absent for now, so that failure is not final. Custom agents are merged at startup and again
before a load names an agent the list lacks, so a `custom-agents.json` agent is never "unknown" for
want of a listing. The daemon decides because it holds the agent's error code, where the host is
sent only the agent's wording. The host answers with `CloseProjectSession`, which names the row by
its key. Every other failure, a crashed agent, a lapsed sign-in or a connection that is down,
leaves the row open to be tried again. The app's zombie worktree sweep asks for the open rows'
folders first, and skips the pass when the daemon cannot answer, rather than deleting the folder a
dormant session loads into.

**A session nobody is watching does not live forever.** `main::reap_idle_sessions` sweeps every
`IDLE_SWEEP` (60 seconds) on its own interval, and it is mark-and-close rather than a deadline: a
session found idle with no client attached is marked, and closed by the next sweep if it is still
both. Any activity in between clears the mark and the session starts over, so a session survives
between one and two minutes after the last client leaves. Idle means `turn_active` is false, so a
session working through a prompt finishes it whether or not anyone is there, and is only marked
once it is done. The close goes through the session's own command loop rather than aborting its
task, because `session/close` is what leaves the agent holding a transcript `session/load` can
replay — an agent without `session/load` loses that transcript, which is the accepted price of not
keeping an unbounded number of agent processes alive. A reopen before the second sweep adopts
the session as it stands; a later one pays a `session/load`.

**An unanswered prompt survives the client it was shown to.** A session blocked on a permission or
elicitation request is mid-turn by definition, so the reaper never takes it. The request itself is
stored beside its `oneshot` sender (`PendingPermissions` / `PendingElicitations` in `sessions.rs`)
and handed back in `LiveSessionState.pending_requests`, because the message that asked went to a
client that is gone. `attach_project_sessions` replays each one through
`reader_task::handle_shared_server_message` **after** inserting the host-side session, never
before: that routing drops anything addressed to a session this side does not hold yet.

**The updater stops the servers before installing** (`stop_resident_servers`, called from
`useUpdater` after the download and before `install()`). A resident server holds its own binary
open and Windows will not overwrite the image of a running process — the same reason the old
child-process servers were killed on quit. Every running session ends with them, which is what the
Install button's tooltip says.

## Project locks live in the daemon

A project is held by one Maestro window at a time, and the daemon of the connection it lives on is
what decides: `maestro-server/src/project_locks.rs`, in memory, keyed by canonical project path, one
lock per attached client (a second acquire releases the first). It sits in `client_sink`'s
`Clients`, so `Clients::remove` releases a client's lock the moment it detaches or a write to it
fails, and the daemon dying takes every lock with it. A client that sends nothing, `Pong` included,
for 30 seconds loses its lock and is told so with `ProjectKicked { Stale }`; its connection is left
alone.

Opening a held project fails with `PROJECT_LOCKED:<holder label>`, and the picker offers a takeover:
the daemon asks the holder (`TakeoverRequested`), and a yes, or no answer within ten seconds, moves
the lock and sends the holder back to the picker with `ProjectKicked { TakenOver }`. The label is the
machine's hostname. Every change is broadcast as `ProjectLocksChanged`, which is what refetches the
picker's lock badges. The app side is `src-tauri/src/project/lock.rs`; `spawn_connection_server`
re-acquires the held project whenever a relay is replaced, since the daemon sees a new client.

## Tasks live in the daemon

A project's tasks, their relationships, instructions, threads and attachments, its worktrees and
its reviews are tables in the daemon's `projects.db`, beside the sessions, in
`maestro-server/src/task_store/`. Every row carries `project_path` where the app's had `project_id`,
so a second machine opening the project over the same connection finds the same board. The app's
commands are one round trip each through `query_project_store`, which resolves the connection and
the canonical path from the app's `project_id`.

- **Ids are per project.** A task is keyed by `(project_path, id)`, minted from a counter in
  `project_counters` that never goes back. A deleted task's `task-<id>` folder or `maestro/<id>-`
  branch can outlive it, and a reused number would hand them to a stranger. Worktrees are keyed the
  same way from their own counter, because a session's folder is `session-<id>` inside its project
  and a global id would collide across the projects on one daemon. Since two projects both have a
  task 3, every command naming a task or worktree carries `project_id` too, and so does every task
  query key in the frontend.
- **A guarded step is one request.** A transition travels with its guard (`TransitionGuard`) and runs
  under the store's lock, as do the composite steps: the turn end (`EndTaskTurn`), closing a
  refinement and requesting execution. A step the guard refuses writes nothing and pushes nothing.
- **Nothing on the shared reader awaits a daemon reply.** The reply to a daemon request comes back
  through the same reader that would be waiting for it, so `reader_task` spawns such requests onto
  a task of their own. A permission request of a task session is settled that way, its blocked
  mark awaited there before the prompt reaches the UI.
- **Every write is pushed.** `TasksChanged`, `TaskCommentsChanged` and `WorktreesChanged` go to
  every attached window, the requester included, and become the `tasks-changed`,
  `task-comments-changed` and `worktrees-changed` events. They carry the app's `project_id`, matched
  from the canonical path, and a listener ignores another project's. A path this app has no project
  for gives a null id, which every listener treats as its own. The app emits none of these itself.
- **Triggers stand in for `ON DELETE SET NULL`.** A deleted task releases its worktree rather than
  taking it, but `SET NULL` on a composite key would null `project_path` too, so
  `tasks_release_worktrees` clears `task_id` first. A deleted worktree drops any task's pin on it
  through `worktrees_drop_workspace_pins`, since SQLite cannot add that foreign key without
  rebuilding `tasks`.
- **Attachments are copied into the project.** Attaching copies the file to
  `.maestro/attachments/tasks/<task_id>/` on the project's machine, through the transfer path prompt
  attachments use, and the row holds the project-relative path. The daemon reads each copy there
  when it composes the prompt and embeds it as before: an image inline, text pasted in, a PDF
  linked. A start from a window first checks them with `prepare_task_attachments` and shows a
  dialog: a missing copy is offered for removal, one too big to send is offered and kept, and the
  user can cancel the start. A start the daemon makes on its own skips them with a note in the
  thread.
- **The zombie worktree sweep asks the daemon.** Its candidates come from `ListWorktrees` and
  `ListTasks`, and a pass is skipped when the daemon cannot answer, rather than deleting a folder a
  row still names.

With no window attached the daemon still answers the MCP task tools, so an agent can read and write
its board. The pipeline that moves a task from stage to stage runs there too; see the next section.

A board from before this move reaches the daemon once per app, from `project/import.rs`, while
the project opens and before its sessions are attached. The rows go in chunks of about 4 MB that
the daemon commits in one transaction, with counters kept above the app's ids and its
`sqlite_sequence`. Every import carries the app's install id (`install_id` in its `settings`), and
the daemon keeps one marker per project and source. The same source is refused, and the app then
stamps its project. The first source keeps its ids, and rows the daemon wrote itself before it are
moved above them, which waits (a retryable failure) while a session, hold or start names one of
those tasks. A later source is merged: `BeginImport` reserves id ranges above the counters and
answers the task offset, the app copies attachments into each task's final folder before it
commits, and the incoming rows move up with every reference. An incoming worktree whose folder or
branch is already there is left out, and a task whose `task-<id>` folder, row or generated
`maestro/<id>-` branch is already taken starts in `task-<id>-2` on `maestro/<id>-2-<slug>`, and so on. A marker from before sources were recorded has a NULL source
and refuses every source, so a store imported by an older build is never imported twice. A failed
import keeps the project closed and the picker offers Retry, since a board shown without its rows
would look empty.

## The daemon drives the task pipeline

A task goes from the queue to its coder, its reviewer and back with every window closed, the way an
automation already runs. That is the reason the driver had to move: while the app classified each
turn and started the next stage, closing the window stopped every task where it stood. Five files
in `maestro-server/src/` carry it. `scheduler.rs` drains a project's queue and hands every stage
over. `task_runner.rs` starts one stage (`StartTask`): the planner first where the project has one,
capacity, the agent, the claim, the worktree from `worktree.rs`'s `prepare_task_workspace`, the
spawn, the stage's profile from `profiles.rs`, the prompt from `task_prompt.rs`, the session ready,
and the session it supersedes closed. `task_turn.rs` reads a turn's end. `session/task_gate.rs`
settles a task session's prompts. `task_restart.rs` is the startup pass. `pipeline_settings.rs`
holds capacity, auto mode and holds.

**There is one driver, and it is the daemon.** The app's drivers, `useQueueDrain`,
`useAgentPipeline`, `useAutoResume`, its turn-end resolver and its auto-approve, went in the same
change that the daemon's arrived, because two drivers both start the next stage. Execute and the
gates call `start_task`, which is one `StartTask` round trip, and the session reaches every window
as `TaskSessionStarted`, adopted like an automation's. A hand-off is never started by the side that
wrote it: every write that can leave a task `Waiting` on an agent (a turn end, a send to review, a
requested CI fix) pushes `TasksChanged`, and the scheduler's debounced drain is the one place a stage
is handed over. The claim on the task keeps a second start from doing anything. The drain also runs
on session close, hold release and a one-minute tick.

**A guarded step is still one request.** The turn end classifies the turn, runs the diff gate with
local `git` (the daemon is on the repository's machine), and writes the outcome as one `EndTaskTurn`
under the store's lock, exactly as a window's would. A start that cannot go ahead with nobody
watching, for want of an agent or a sign-in, fails with a note in the thread rather than retrying.
The claim overwrites the phase with `Spawning`, so it keeps the one it took in `claimed_from`: a start
that does not come up goes back to that phase, failed, where the stage it hands to can claim it again,
and a retry's prompt still knows it is reworking or fixing CI. `claimed_from` stays equal to the phase
there, which is how the card offers Retry for that stage and tells a CI fix that did not start from a
closed pull request.

**Capacity is the machine's, and a slot is a live task session.** The limit is per daemon, shared by
every app attached to it, and in Auto it is measured on the daemon's own machine. Only task sessions
in the session map count, plus the starts claimed anywhere, a drain's, a hand-off's or a window's,
whose session is not in the map yet (`task_runner::in_flight`, read by the loop with the map), so a task waiting at a human gate frees its slot once its session goes. A hand-off is
not held back by the limit, since the session it follows usually still holds the slot it takes. Auto
mode is per project, and holds are an in-memory map whose entries lapse unless renewed (ten seconds unless the window names
a TTL) and which dies with the daemon,
so a hold cannot outlive a crash and keep a task off the queue with nothing to explain it.
`CapacityStatus.stored` says whether the machine has a setting of its own: the app reads its old
`connection_settings` row once per connection and sends it as `SetCapacity` only when it is false.
`CapacityStatus.used` is the slots taken as the limit counts them, every attached app's included,
and is what the board's badge shows.

**Forge work stays in the window.** Opening a pull request, polling its CI, asking for a CI fix,
merging and approving need the forge token, which is in the app's keychain and never reaches the
daemon. A task waiting on its pull request therefore waits for a window, and everything else keeps
moving. The one exception is the CI fix's push: the daemon pushes the fixed branch with plain
`git push` to the configured remote, so CI starts with no window, and the app reads the result on
its next poll. The dirty-worktree question is the app's too, since it needs someone to answer it.

**A coder's prompts are answered without asking.** `task_gate.rs` approves the permission requests
of a coder in a phase that may write, and nobody else's. A read-only stage that delivers a plan by
asking to leave plan mode has the plan taken as its artifact and the session closed. Anything else
marks the task blocked and waits for a user; a window's answer, or any prompt it sends the session,
clears the mark.

**The main loop runs on the main thread's stack, 1 MB in a Windows debug build.** A future awaited
inline in that loop is part of the loop's own state machine, so one large `async fn` there
overflows the stack with no hint of where. That is why `dispatch_message` and `dispatch::settle` are
`Box::pin`ned, why the turn end boxes each step, and why the slow half of a start (`launch`: the
worktree and the agent) is spawned and hands back through `Settle::TaskStarted`. Box or spawn
anything new and large that the loop awaits.

**Nothing on the shared reader awaits a daemon reply**, as in the section above. A task session's
permission request is settled on a task of its own, its blocked mark awaited there.

**The startup pass runs once, before the loop.** Every session died with the previous daemon, so a
task the board shows as worked on has nothing behind it. A `Spawning` claim with no session is
released (`SpawnInterrupted`): a hand-off goes back to waiting on its agent, anything else where
`SpawnAborted` puts it. A `Waiting` hand-off is started again. A task whose session was mid-turn has that
session reloaded, its model, mode and effort applied again, and is told to resume. A `Blocked` task
is resumed only when its turn was live at shutdown, since the prompt it waited on died with the
agent, which asks again if it still needs the answer; one whose agent ended its turn to ask the user
is waiting on that user and is left alone. Whether a turn was live is recorded at a clean shutdown,
so after a crash a blocked task is left for the user. A task whose agent cannot reload a session
fails with a note. The queue drains after.

**`SESSION_RELOADING_ERROR` is not a load failure.** A window opening the project while the startup
pass is reloading a session would load it a second time, so the daemon refuses that load with
`session_reloading`. The window drops its pending entry, neither closing the row nor touching the
task, and waits for `TaskSessionStarted`. It is deliberately not prefixed with
`SESSION_LOAD_FAILED_ERROR`, which would tear the session down.

**A sign-in refusal names its agent.** `StartTask` refuses with `auth_required:<agent_id>`
(`auth_required_for`), because the daemon picks the stage's agent and the window cannot know which
one to sign in to. The picker's choice travels as the request's one-shot `agent_id`, which wins over
the task's and is never written to it. The picker also makes it the project's default agent.

## Automations live in the daemon

An automation is a prompt, an agent and a workspace, run on a schedule or on demand. **None of it
is stored or driven app-side.** `maestro-server/src/automations.rs` owns `automations.db` next to
the daemon's lock, holding every project on that machine; `automation_runner.rs` is the clock. The
app is a client: `project/automations.rs` is five commands that are each one round trip, and
`.maestro/automations.json` is gone.

That split is forced by the premise. A schedule has to fire for a project no window has open, so
the store cannot be something an open project brings with it, and for an SSH, WSL or container
project the database that would hold it is not even on the machine the agent runs on.

- **A project is its canonicalized path**, resolved by the daemon, because it is the process on the
  machine that path exists on. The app sends the path it knows and stores whatever comes back.
- **Schedules are five-field cron plus an IANA timezone, and the editor is the expression.** There
  is no preset layer above it, so nothing snaps and nothing is ever read only.
  `to_crate_expression` fixes up the two places the `cron` crate disagrees with a crontab: it wants
  a seconds field, and it counts Sunday as 1 rather than 0.
- **The zone is a choice between two machines, never a list.** `ListAutomations` returns
  `server_timezone` beside the rows, and the editor offers that or this computer's — and shows no
  control at all when they match, which is every local project. A stored zone that is neither is
  kept and offered as a third option rather than silently rescheduled onto the nearest.
- **`next_due_at` is computed on read and never stored.** Nothing outside the daemon parses cron.
- **A missed occurrence is dropped.** The floor for the first firing is when the server started, so
  a machine asleep for a day does not wake up and work through twenty-four hourly runs.
- **A `runs` row opens before anything is spawned**, so a run that fails to start is still a run
  that happened, and it carries the session id. That row is the only link between an automation and
  its session. A window already attached learns of the session from `AutomationRunChanged`, which
  is sent with a session id only once the session has its row in the project store and its entry
  in the session map, so `adopt_automation_session` always finds it.
- **The run ends on `TurnEnded`**, routed through `helpers::TURN_TX` because turns end deep inside
  a session's command loop, which holds none of the state that reacts. The session is then left
  idle for the sweep above.
- **`NewWorktree` is the daemon's own**, made and unmade by `maestro-server/src/worktree.rs`. See
  below.

**Templates are the exception, and app-side on purpose.** `src-tauri/src/templates.rs` keeps them in
the app's own `templates` table, because a template belongs to the user rather than to a machine and
has to be there on every connection. An automation template holds a prompt and a trigger, never an
agent or a workspace, which are the project's. The body is JSON tagged by kind, so skills or MCP
servers are a new `TemplateBody` variant rather than a new table. The built-in templates
are not stored: they are `src-tauri/assets/builtin-templates.json`, read by `templates.ts` for the
Templates page and by `templates::builtins` for the agent's template tools.

**Prompts are two collections, and only the shared one is app-side.** A prompt is text the user
copies into an agent: title, body, tags, a favorite flag. A project's collection is in its daemon
(`maestro-server/src/prompt_store.rs`), so every app opening the project sees it. The **shared**
collection is the app's `prompts` table, `project_id IS NULL`, read by `src-tauri/src/prompts.rs`,
because a shared prompt belongs to no project and has to be listed in every one this app opens.
Rows with a `project_id` are earlier builds' project prompts, unread until the phase 4 import; the
v31 migration kept the star each one had in its own project for that import to carry. Moving a
prompt between the two is a copy into the other store, unstarred, with no link back, and nothing
syncs them. Favorite is a column on each row in both, one star per prompt rather than per project,
and favoriting goes through its own command so it leaves `updated_at`, and the list order, alone.
Every change is the `prompts-changed` event, whose `collection` is `"shared"` or `"project"`; a
project's carries its `project_id`, which is `null` when the daemon named a path the app cannot
match, and then every project's list is refetched.

## A worktree an automation made

`maestro-server/src/worktree.rs` runs plain local `git`. There is no `GitConnection` equivalent and
there must not be: the daemon already runs on the machine the repository is on, which is the whole
reason the app has to tunnel git over SSH, WSL and Docker and this does not. Creation and removal
live here; diff, review, merge, staging and remote are still the app's.

`.maestro/worktrees/automation-<slug>-<n>`, on branch `maestro/automation-<slug>-<n>`. The slug is
fixed when the automation is first saved and stored in `automations.slug`, so renaming an automation
does not move the directories its earlier runs made — `worktree_slug` reads the column rather than
re-slugifying the name. `n` is `runs.ordinal`, the run's number within its automation, counted from 1
and restarting for an automation deleted and recreated, so a worktree kept from run 3 never blocks
run 4. The same number is the `#3` on the run card and on the session row, which is how a session is
matched to its entry in run history: the row joins on `agent_session_id`, so a run reopened after the
sweep still finds its number.

**The agent process is spawned with the project as its cwd, not the worktree.** The pooled agent
connection outlives the run, and on Windows a process whose working directory is a directory makes
that directory undeletable. `session/new` carries the worktree path, which is what the agent works
in.

**Cleanup happens at session close, not at turn end**, for the same reason: the agent holds files
open under the workspace for as long as the session lives. Every close settles it: the `Cancel` arm
in `dispatch.rs` (closing the session in the app, or Stop on the automation row) and
`reap_idle_sessions` both call `settle_worktree_for_session` once the close has run. The sweep only
closes sessions nobody is attached to, so with a window open a run's worktree stays until its session
is closed there, and while it stays the user can still talk to the agent in it. `sweep_worktrees` at startup catches the runs whose sessions died with an earlier daemon.

**Deleting a run takes its worktree and branch, whatever they hold.** That is the user's call, made
per run from its card or per project through retention (`retention` table, `RunRetention`): a run
goes once it is past the newest `keep_last` of its automation **and** older than `max_age_days`, and
a project with no row gets 50 and 90. It is applied after every run ends and at startup, off the
main loop because removing a worktree is a git process. A running run is never deleted, and the
server refuses a manual delete while the run's session is still open. Run numbers come from
`automations.runs_started`, not a count of rows, so a deleted run's number is never reused.

**What "nothing would be lost" means** is the app's own rule, ported: `git status --porcelain` clean,
**and** `git branch --all --contains HEAD` naming something besides this branch. That second half is
what makes a merged branch and a pushed branch both safe to delete, and a branch whose commits exist
nowhere else — including in a repository with no remote — kept.

`runs.worktree_path` is a live pointer, cleared on removal, so a value in it means a directory
somebody still has to deal with. `runs.worktree_kept` is why. `is_maestro_created_worktree` does not
match this naming, which is deliberate: the app's zombie sweep must not reap a worktree the daemon
owns. The app adopts a `worktrees` row for each one in `adopt_automation_worktrees`, so a kept
workspace appears on the Workspaces screen like any other; `list_worktrees_with_status` prunes that
row on its own once the directory is gone.

## Webhooks

`maestro-server/src/webhook.rs` serves `POST /hooks/<automation_id>` on a listener of its own, not
on `attach`'s: that one speaks the framed protocol to a token-holding client, this one faces
whatever the user points at it. It binds `127.0.0.1:7433` by default. Port, bind address and the
**public URL** (a tunnel's or reverse proxy's, which the editor builds each webhook URL from) are
per machine, stored in `webhook_settings` and edited on the Settings page's per-connection Webhooks
entry. Maestro serves no TLS and runs no tunnel.

A request is judged in an order that keeps a stranger from affecting the real sender: the secret
first (a GitHub-style `X-Hub-Signature-256` over the body, or `Authorization: Bearer <secret>`,
both constant time), then the switches, then dedupe, the rate limit and the overlap rule. Nothing
counts against the dedupe window or the rate limit until the request has proved it knows the
secret, and only a delivery that started or queued a run is remembered for dedupe, since one refused
is one the sender is right to retry. `deliveries` keeps the last 20 per automation, plus anything younger than the dedupe window that
carries a key. The ones that started no run appear in that automation's own history among its runs,
and nowhere else: the project-wide history is about runs.

The run is started by the main loop, which alone holds what a spawn needs: `FIRE_TX` carries an
accepted delivery there and the answer back, and the sender gets 202 as soon as the run is opened.
Queued deliveries live in `webhook_queue` and are drained after a turn ends and on every tick.

An automation has **one trigger**, a schedule or a webhook, never both: `validate` refuses a cron
expression beside `webhook_enabled`, and the editor offers None, Schedule or Webhook as one
choice. `enabled` is the row switch and pauses whichever it is, so the editor never writes it; with
None there is nothing to pause, and the switch stays off.

## The Maestro MCP server

Agents get a channel back into Maestro that returns a value: `maestro-server` registers **itself**
as an MCP server on every `session/new` and `session/load`, as a stdio entry whose command is its
own binary and whose argument is `mcp`. Stdio is the ACP v1 baseline every agent must support
(`mcp_config.rs`), so there is no capability gate and no HTTP server to run. Tool descriptions
arrive in-band through `tools/list`, so nothing here depends on a skill being installed.

```
agent ──stdio (MCP JSON-RPC)──▶ maestro-server mcp   (the shim, one per session, spawned by the agent)
                                     │ one TCP connection per tools/call, 127.0.0.1:PORT + token
                                     ▼
                              maestro-server (running)  ── existing framed stdio ──▶ Tauri ──▶ UI
```

Three files:

- `maestro-server/src/mcp_stdio.rs` — the shim (`maestro mcp`). Serves the tool surface from
  `assets/mcp-tools.json` and forwards every call to the gateway.
- `maestro-server/src/mcp_gateway.rs` — the loopback listener in the running server. Draws canvas
  surfaces itself by emitting a `SessionUpdate`, and parks every call — canvas ones included — in
  `PendingHostTools` until Tauri answers.
- `src-tauri/src/acp/host_tools.rs` — the host end: `canvas_await`, with the automation and
  template tools in `acp/automation_tools.rs` and the shared prompt tools in `prompts.rs`.

The task tools are the exception: the gateway answers them itself from `projects.db`, through the
same `task_store::requests::answer` a window's request goes through, so they are never parked.

The prompt tools are split by collection, and the agent names a prompt `project-N` or `shared-N`
because the daemon and the app mint ids independently. A project prompt is answered by the gateway
from `prompt_store`, scoped to the session's project, with no window needed. A shared one is
forwarded with its bare id to exactly one window, the session's owner or else the window attached
longest, and that window answers it whether or not it holds the session, since the call needs no
session state. With no window attached a shared call is refused, and `list_prompts` returns
whichever collection it could read with a `project_unavailable` or `shared_unavailable` note for
the other. Both collections answer with the same keys.

Port, token and session id reach the shim as environment variables on the `McpServerStdio` entry,
so nothing is inherited or guessed. The listener binds loopback only and the token is a v4 uuid;
any local process can connect, so the token is what decides whether a call is answered. A user
`.mcp.json` entry named `maestro` is skipped with a reason, the same rule a `custom-agents.json`
id collision follows. If the gateway fails to bind, nothing is injected and the session runs
without canvas and task tools.

| Tool                                              | Answered by                                    | Result                        |
| ------------------------------------------------- | ---------------------------------------------- | ----------------------------- |
| `canvas_create` / `canvas_update` / `canvas_data` | drawn by the gateway, acknowledged by the host | `{ok}`, plus frame `{errors}` |
| `canvas_await`                                    | the host, after the user acts on the surface   | `{event}` or `{timeout}`      |
| `create_task` / `list_tasks`                      | the gateway, scoped to the session's project   | the task, or the list         |
| `get_task` / `update_task` / `comment_task`       | the gateway, scoped to the session's project   | the task, or the new entry    |
| automation and run tools (`*_automation*`)        | the host, scoped to the session's project      | the automation, or the run    |
| template tools (`*_template*`)                    | the host, app-wide; built-ins are read-only    | the template                  |
| prompt tools on `project-N`                       | the gateway, scoped to the session's project   | the prompt, or the list       |
| prompt tools on `shared-N`                        | the host, any one attached window              | the prompt, or the list       |

A task tool works with no window attached: the session's project and task come from its binding
in the daemon's session map, and the write is pushed to whatever windows there are, or to none.

**`run_automation` asks the user first**, as an ordinary permission prompt: it emits
`acp://permission-request/<session>` itself and parks the answer in `pending_host_tools`, and
`respond_acp_permission` takes it from there before anything is forwarded to the server. The call
waits at most 60 seconds, under the gateway's 90, and answers `{pending}` after that; the answer is
acted on by a task of its own, so a run approved later still starts.

A canvas call goes both ways on purpose: the gateway emits the session update because it owns that
channel, and the _same_ call is then forwarded to `host_tools::canvas_ack`, whose answer carries
back whatever that surface's frame has failed to load or run since the last call. The agent never
sees its own surface, so this is the only way a blocked asset or a thrown exception reaches it.
They arrive on the **next** call by necessity — the frame has not rendered this one yet.

**Adding a tool** is two edits: an entry in `assets/mcp-tools.json` and an arm in
`host_tools::handle`, or in `mcp_gateway.rs` for a task tool. The entry's `description` is the _only_ documentation the agent gets — it
carries what the skill prose used to — so it is prose, not a label, and belongs in that asset
rather than in Rust for the same reason `registry.json` does. `build_tools` loads it and does
nothing else.

A tool added to the manifest without a matching arm in `host_tools::handle` is worse than a
missing tool: the agent is told it exists, calls it, and gets `unknown Maestro tool` after a full
round trip.

`canvas_await` is a poll, not an open wait: MCP clients enforce tool timeouts, so it promises at
most 60 seconds and the description tells the agent to call again. The canvas controls are live
only while one is pending, which is why a click cannot be silently dropped between polls.

## Skills and MCP servers in Collections

Both are per machine and live with the daemon, beside `tools.json`: `~/.maestro/mcp-servers.json`
(`maestro-server/src/mcp_store.rs`), and `~/.maestro/skills.json` with the files under
`~/.maestro/skill-library/<name>/` (`maestro-server/src/skills.rs`). The app's half, commands and
catalogs, is `src-tauri/src/collections/`.

- **MCP servers reach agents by injection.** `mcp_servers_for` appends every managed server that
  lists the session's agent id, after `.mcp.json`, through the same `convert_entry`, so capability
  gating and `${VAR}` expansion apply. The project's file wins a name collision; `maestro` is
  reserved.
- **Secrets never touch the daemon's disk.** Secret rows are stored blank there. The values are in
  the OS keychain (`maestro.mcp`, account `<connection>:<server>:<key>`, through
  `KeychainStore::set_secret`) and pushed into the daemon's memory with `SetMcpSecrets` after every
  preflight and every change. A daemon restarted with no window open has none, and skips those
  servers until the app connects again. Secret rows are a remote server's headers (bearer token,
  OAuth token, custom headers); a stdio server's environment is plain text, as in `.mcp.json`,
  by the user's choice. OAuth client settings ride along as `ManagedMcpServer.oauth`, opaque to the
  daemon; a client secret or private key lives in the keychain grant (`<server>:oauth`), and a
  user-registered client redirects to the fixed port `mcp_oauth::REDIRECT_PORT`.
- **Skills deploy through the pinned skills CLI**: `add <library>/<name> -g -y -a <agents>` and
  `remove <name> -g -y -a <agents>`, mapped by `AGENT_SKILL_TARGETS` from Maestro agent ids to the
  CLI's keys, checked against its agent table. Several CLI agents share `~/.agents/skills`, so
  switching a skill off for one can switch it off for its neighbours.
- **Catalogs**: the GitHub MCP Registry (`api.mcp.github.com`, ~300 servers, 100 a page) for MCP,
  read whole on first view and searched in the webview. For skills, skills.sh's all-time
  leaderboard (`/api/skills/all-time/<page>`, ~10k skills, 200 a page, most installed first) and its
  search, paged in on demand: reading all ~50 pages at once trips skills.sh's limit of 30 requests a
  minute (429). Both are cached for the life of the window (`staleTime`/`gcTime: Infinity`); only
  the refresh button reads them again. The leaderboard endpoint is undocumented, the one the
  skills.sh site pages through itself. Fetched in Rust because skills.sh sends no CORS
  headers. No listing carries descriptions. A card shows the `<meta name="description">` of the
  skill's skills.sh page (cached, cut at ~160 characters); hovering it fetches the whole one from
  `skills.sh/api/download/<owner>/<repo>/<skill>`, which allows 60 requests an hour. Installing is the daemon's: it runs `add <owner/repo> --skill <name>`
  at project scope in `~/.maestro/skill-fetch/`, moves the copy into the library, and installs from
  there, so a skill's binary assets arrive with it. Only `owner/repo` sources are listed.
- **Test connection runs in the daemon**, for every transport (`mcp_store::test`): a stdio command
  has to exist on the connection's machine and a URL has to be reachable from it, since that is
  where the agents run. `reqwest` is in `maestro-server` for this alone.
- **Listed but not managed**: the project's `.mcp.json` and the skills in its agent directories
  (`AGENT_SKILL_TARGETS`' third column, e.g. `.claude/skills`), read by the daemon on
  `ListMcpServers` / `ListSkills` with a `project_path`; and Maestro's own `maestro` server and
  bundled skills, drawn read-only.

## Bundled ACP agent registry

`maestro-server/src/assets/registry.json` is vendored: it is committed, `include_str!`'d by
`agent/registry.rs`, and never fetched during a build. Entries in it decide which executable and
arguments `maestro-server` spawns, so treat changes to `package`, `version`, `args`, `cmd` and
`archive` fields as supply-chain changes and review them as such.

Refresh it through the `Update agent registry` workflow (weekly, or run it manually), which
fetches, validates and opens a pull request. Do not reintroduce a build-time fetch: writing to the
tracked file on every build made builds unreproducible and let agent version bumps ride along in
unrelated commits.

**Never add a hand-written entry to `registry.json`, and never synthesize an agent in
`registry.rs`.** Anything the bundled list does not cover — a local gateway, an internal adapter,
the same adapter with different environment variables — is user configuration and belongs in
`~/.maestro/custom-agents.json` on the machine that runs the agent, merged by
`registry::apply_custom_agents` (see below). Hardcoding one costs a release per variant and, since
`detection.rs` has no entry for it, a matching special case in the host's discovery filter.

## User-defined ACP agents (`~/.maestro/custom-agents.json`)

Same schema as `registry.json`, on the machine `maestro-server` runs on — the remote home for SSH,
WSL and container connections, next to the `tools.json` that `tool_config.rs` already reads there.

It is re-read on every `ListAgents` and `DetectInstalledAgents` rather than at startup, so an agent
added mid-session appears without restarting the server; the host's five-minute discovery cache is
what still delays it in the UI. Entries are additive — an id colliding with a bundled agent is
rejected and logged, so a typo cannot shadow a working agent. There is no detection table entry for
a custom agent, so `maestro-server` reports it as installed unconditionally and a wrong command
surfaces as a spawn failure instead of a silently missing picker entry.

The `maestro-custom-agents` skill (`src-tauri/assets/skills/`) is what writes this file: it is
installed onto every connection alongside `maestro-output`, and interviews the user before writing.
It carries `disable-model-invocation: true`, so it only runs when the user types
`/maestro-custom-agents` — writing to a file outside the project on a model's own initiative is not
something to do behind the user's back. Its schema documentation and Ollama recipe are user-facing
and mirrored in `docs/custom-agents.md`; keep both in step with `resolve_spawn`.
