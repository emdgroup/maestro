# Automations, and the resident server underneath them

Working plan for the Automations feature and the `maestro-server` rework it needs. Written to be
updated in place: each phase records the decisions that are locked, so a later session does not
re-litigate them or lose the reasoning.

**Nothing in this plan ships in a release until the last phase is done.** Intermediate phases land
on `main` but are not part of a release build.

**Before starting any phase, ask as many questions as needed to eliminate doubt.** That is the
working agreement for this feature, not a suggestion. Questions come first, implementation second,
one phase at a time with review in between.

## Where it is going

An automation is a saved instruction plus a trigger. The trigger fires whether or not the Maestro
window is open, so the thing that runs it cannot be the window. `maestro-server` becomes a resident
per-machine daemon that owns sessions, worktrees, the schedule and the webhook endpoint, and the app
becomes one of its clients.

```
                    ┌─ schedule (cron)
                    ├─ webhook (POST /hooks/<id>)
                    └─ "Run now" from the app
                              │
                              ▼
   app ──attach──▶  maestro-server daemon  ──▶ agent sessions in git worktrees
   (a client)        (resident, owns state)
```

## Phase status

| Phase | What                                          | State                         |
| ----- | --------------------------------------------- | ----------------------------- |
| 0     | Session identity: one opaque id everywhere    | Done, `4f08e9aa`              |
| 1     | Resident mode: daemon, `attach`, re-adopt     | Done, `0fc3a63c` + `93d2b9b7` |
| 2     | Session ownership and lifetime                | Done                          |
| 3     | `automations.db`, and the clock that reads it | Done                          |
| 3.5   | The schedule editor, and run history          | In progress                   |
| 4     | Worktree provisioning moves into the daemon   | Planned                       |
| 5     | The clock                                     | Folded into phase 3           |
| 6     | Webhooks                                      | Planned                       |
| 7     | Autostart and consent                         | Planned, last before release  |

## Decisions that span every phase

Taken before phase 0 and not reopened since:

- Automations live in **SQLite only**. No `automations.json` as a second source of truth.
- A project is keyed by its **canonicalized path**, not by the app's database id, because the daemon
  serves projects from more than one app run.
- **Worktree provisioning moves into `maestro-server`.** An automation that needs a worktree cannot
  depend on the window being open to get one.
- **The server survives the app closing.** This is the whole premise.
- **Missed occurrences are dropped**, not queued. A machine that was asleep for a day does not wake
  up and run twenty-four hourly jobs.
- **Webhooks are served by the resident server**, not by the app.
- **The app always talks through the resident server**, interactive sessions included. There is no
  second path for "normal" sessions to take.

## Phase 0: one session id, everywhere (done)

The wire id was app-minted from a counter that restarted at 1 each run. A resident server would see
colliding names across app runs, so this had to be fixed before anything else.

Decisions:

| Topic    | Decision                                                                         |
| -------- | -------------------------------------------------------------------------------- |
| Identity | One id everywhere: the id the server files a session under is the id React holds |
| Type     | Opaque uuid v4, minted by `core::new_session_id()`, not a counter                |
| Naming   | Renamed as well as retyped: `session_id` / `sessionId`, never `log_id`           |
| Scope    | PTY sessions took string ids too, because `ActiveSessionInfo` carries both kinds |
| Ordering | Landed before phase 1, with tests green                                          |

Found and confirmed safe during the investigation: `log_id` was never in SQLite, so no migration,
and nothing anywhere ordered or compared ids numerically.

Two defects were surfaced rather than silently fixed:

- `BoardView` to `ExecutionTerminal` passes a **task** id to `attach_terminal`, which looks up the
  PTY map by **session** id. Ported faithfully as `String(taskId)`. The side panel path
  (`SidePanelContent` to `ptyEntry.key`) passes the correct id. Still unfixed, deliberately.
- The auth store now keys on a string, which is a task id for a task's session and a session id for
  a manual one. See `effectiveAuthKey` in `AgentActivityPanel`.

## Phase 1: resident mode (done)

See the `### The resident maestro-server` section of `AGENTS.md` for how it works. This records
what was decided and why, which that section does not.

| Topic               | Decision                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Extra artifacts     | None. `daemon` and `attach` are argv modes of the same binary, like `mcp` and `--exec-channel` |
| Transport           | `attach` is a pure byte relay, stdin and stdout to a loopback socket plus a uuid token         |
| Host transport code | Untouched. All four paths still speak the framed stdio they always did                         |
| Who starts it       | `attach` does, under the lock. The app never starts a daemon directly                          |
| Scope               | One daemon per machine, distro or container                                                    |
| Files, local        | `<MAESTRO_DATA_DIR>/daemon/`, so a dev build does not contend with the installed app           |
| Files, remote       | `~/.maestro/daemon/`, **not** version-namespaced                                               |
| Alive check         | The lock file, never `runtime.json`, which a crash leaves behind pointing at a dead port       |
| Version skew        | Kill and restart, unconditionally, over a plain-text `SHUTDOWN` line read before any framing   |
| Cutover             | Hard. The child-process path was deleted, not kept as a fallback                               |
| App close           | Sessions are not cancelled. The relays are dropped and the daemon keeps running                |
| Re-adopt            | `ListLiveSessions` filtered to the open project, then rebuild host-side entries                |
| Session metadata    | An opaque `host_meta` blob the server stores and never parses                                  |
| Transcript          | Close and reload a session between turns; adopt one mid-turn as it is                          |
| Daemon crash        | `attach` reconnects with backoff and starts a new daemon                                       |
| Buffering           | None. The agent's own history plus `session/load` is the replay mechanism                      |
| Off switch          | None until phase 7                                                                             |
| Verification        | Unit tests plus a manual local Windows pass                                                    |

Rejected along the way, with the reason:

- **A per-session buffer in the daemon.** The agent already persists its history and `session/load`
  replays it, so a buffer would duplicate it and put an unbounded allocation in a resident process.
- **Auto `session/load` on adopt, without closing first.** `maestro-server` would replace its own
  map entry while the displaced command loop kept running, leaving an agent that nothing routes to
  and nothing stops. This is why `turn_active` exists.
- **Persisting session metadata to SQLite.** A schema bump, and a row that can outlive the session
  it describes. The blob travels with the session instead.
- **Typed protocol fields for session metadata.** Every new host-side field would cost a
  `PROTOCOL_VERSION` bump and a redeploy on every connection.

`PROTOCOL_VERSION` went 3 to 4, so every connection redeploys `maestro-server` at first use.

### Known consequences, accepted

- **A dev build and the shipped app retire each other's remote daemon.** Remote daemons are not
  version-namespaced, and version skew kills. Local is unaffected because the data directories
  differ.
- **A close that succeeds but whose reload fails leaves the session gone from both sides**, with
  only a log line. The snapshot restore that runs immediately after usually recovers it from
  `.maestro/state.json`.
- **Updating ends every running agent session.** `stop_resident_servers` runs after the download and
  before `install()`, because the daemon holds its own binary open and Windows will not overwrite a
  running image.

### Still outstanding

The manual Windows pass: `bun run tauri:dev`, run an agent, close the window, reopen. Expect the
session back with its transcript when it was idle, `.maestro/dev-data/daemon/{lock,runtime.json}`
on disk, and `maestro-server.exe` still running after the app exits.

## Phase 2: session ownership and lifetime (done)

Phase 1 made sessions immortal. This phase decides when they end.

The pre-phase interview cut the scope roughly in half. Three of the four things originally listed
here turned out to be premature: automation runs do not exist yet, and caps on concurrency and
duration only bite when something can spawn without a human in the loop.

| Topic                | Decision                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Scope                | Only what exists now. Automation-run lifetime moves to phase 5, beside the runner         |
| Session kinds        | None. Every session is interactive; phase 5's in-daemon runner can mark its own           |
| Idle session         | Marked by one sweep, closed by the next if still idle. One to two minutes in practice     |
| Idle                 | `turn_active == false`. A turn in flight runs to completion, then gets marked             |
| Resuming             | Clears the mark. A session that comes back to life starts the whole grace period over     |
| Where the timer runs | The daemon, on its own 60 second sweep. The host is not alive to be asked                 |
| How it closes        | `SessionCommand::CloseSession` through the command loop, never a task abort               |
| No `session/load`    | Reaped uniformly. Those sessions lose their transcript, accepted over unbounded processes |
| Permission timeout   | None. A blocked session is mid-turn, so the reaper never takes it                         |
| Unanswered prompts   | Kept with their sender, returned by `ListLiveSessions`, replayed to whoever adopts        |
| Replay routing       | After the host-side insert, through `handle_shared_server_message`                        |
| Concurrency cap      | None in phase 2. A human clicking spawn is already rate limited by being a human          |
| Duration cap         | None. The user will get a stop control instead, deferred                                  |
| Cap configuration    | Hardcoded constants, made configurable in phase 3 when `automations.db` exists            |
| Protocol             | No `PROTOCOL_VERSION` bump: `pending_requests` is additive with a serde default           |

Rejected along the way, with the reason:

- **A blind re-send of outstanding prompts the moment a client attaches.** It arrives before the
  host has adopted anything, so every message names a session this side does not hold yet and is
  dropped. It would also push prompts belonging to projects this window never opened.
- **A 30 minute permission timeout.** The reaper already exempts a blocked session, and a person
  who walks away from a prompt they meant to answer is not a condition to recover from.
- **`session_kind` on `SpawnRequest`.** A protocol bump and a redeploy on every connection, to
  carry a distinction nothing makes until phase 5.

Still open, deliberately: **only the client that started a session sees its output.** There is no
fan-out, and a rolling per-session window that would let a second client catch up mid-session is
only worth its memory once a second client exists.

## Phase 3: `automations.db`, and the clock that reads it

Phase 5 was folded in here during the interview. Storing automations in the daemon and leaving the
clock in the window would have meant a cron evaluator in TypeScript, written to be deleted two
phases later; moving the firing at the same time as the store writes that logic once, where it
stays.

| Topic            | Decision                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Owner            | The daemon, on whichever machine the project lives on. The app does CRUD over the protocol   |
| Location         | `<daemon dir>/automations.db`, beside the lock, so a dev build gets its own                  |
| Tables           | `projects`, `automations`, `runs`, all three now                                             |
| Project key      | Canonicalized path, canonicalized by the daemon, which is the machine the path exists on     |
| Schedule         | A cron expression and an IANA timezone. The editor keeps its presets and compiles to cron    |
| Timezone choice  | Two machines, never a zone list: this computer or the one it runs on. No control when equal  |
| Next occurrence  | Computed by the daemon and returned with each automation, so no client parses cron           |
| Import           | None. `.maestro/automations.json` never shipped, so there is nothing to migrate              |
| Workspace        | Stored as a path, not the app's worktree row id, which means nothing on the daemon's side    |
| `NewWorktree`    | Refused this phase. Worktree creation is bound to the app's `worktrees` table — see phase 4  |
| Who fires        | The daemon, on a 60 second tick, for every project in its database, app open or not          |
| Run records      | A `runs` row per firing, holding the session id it spawned                                   |
| Session metadata | The daemon does not write `host_meta`. The app adopts the sessions its own `runs` rows name  |
| Run events       | Pushed to whoever is attached, plus a run list on attach for what was missed                 |
| After a run      | The session is left idle. Phase 2's sweep closes it, or leaves it alone if the user is there |
| Protocol         | `PROTOCOL_VERSION` 4 to 5. CRUD, run list and run events are all new messages                |

Deferred out of this phase by the interview: **what a `NewWorktree` run leaves behind** is an
automation setting, not a global rule, and is decided in phase 4 along with the provisioning.

## Phase 3.5: the schedule editor, and run history

Phase 3 shipped a store and a clock behind an editor that offered four presets, and a list that
never showed what a run had done. Both were provisional and both are replaced here. Designed
against mockups rather than in prose, which is why the decisions below are narrow.

### The schedule editor is the cron expression

| Topic           | Decision                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------- |
| Model           | The five-field expression, edited directly. No preset layer above it and nothing to map onto  |
| Sentence        | A read-only line above the fields saying what the expression means, built from the fields     |
| Templates       | The sentence is a button opening a menu of ten, one per cron mechanism, never one per number  |
| Fields          | Five slots side by side, labelled, styled like an OTP entry. Free text, validated per field   |
| Paste           | Pasting a whole expression into any slot fills all five, the way an OTP field takes a code    |
| Docs            | A popover over the focused slot: range, the six forms, and what this slot currently says      |
| Invalid         | Red slot, the error replaces the sentence, Next empties, Save refused                         |
| Next            | One occurrence, from the daemon. Nothing here parses cron to decide when anything runs        |
| Toggle          | One boolean. `Schedule` writes `enabled`; the expression stays, so pausing remembers it       |
| Day-of-week     | Day names in the UI and in the sentence. The 0-or-1 Sunday question never reaches a user      |
| DOM against DOW | Cron ORs them when both are set, so the sentence says "or". There is no run list to expose it |

**The parser is per field and decides nothing.** One function turns `9-17` into a value, and it is
used three times: to colour the slot, to write that field's clause in the sentence, and to refuse
25 before it is saved. It never answers "when does this run", which stays with the daemon, so this
is not a second cron implementation.

`ScheduleKind`, `toCron` and `fromCron` are deleted: they exist only to move between four named
presets and an expression, and with the expression edited directly there is nothing to move
between. `describeSchedule` is replaced by the sentence builder, which the automation row uses too,
so a row and the editor describe a schedule the same way instead of the row falling back to raw
cron for anything the presets could not name.

### Run history

| Topic        | Decision                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Shapes       | Both: the automation row expands to its own runs, a panel beside the list aggregates every one |
| Data         | One `list_automation_runs` query feeds both, so the two can never disagree                     |
| Panel        | Right of the list, collapsible, grouped by day, one card per run                               |
| Filter       | All, Needs input, Failed                                                                       |
| Needs input  | Not a run field. A Running row whose session is awaiting, joined against live session state    |
| Open a run   | Opens the session normally. `session/load` when the sweep has closed it. No read-only mode     |
| No reload    | An agent without `session/load` gets no button on that row rather than one that fails          |
| Notification | A scheduled run that asks a question, through the path sessions already use                    |
| Unanswered   | Waits. The user closes it by hand, and the reaper leaves it alone because it is mid turn       |

## Phase 4: worktree provisioning in the daemon

Moves worktree creation out of the app so a scheduled or webhook-triggered run can provision one
with no window open. `git/worktree_lifecycle.rs` reserves a row id in the app's `worktrees` table
and names the directory from it, so the question is not only what moves but who owns that table
afterwards.

Also decides what a run leaves behind, as a per-automation setting: a branch per run kept for
review, one workspace reused across runs, or a workspace removed when the run changed nothing.

## Phase 6: webhooks

`POST /hooks/<automation_id>` on the daemon, with a per-automation secret and HMAC verification,
request dedupe, a body size cap and a rate limit.

Open: whether the endpoint is on the same loopback listener as `attach` or a separate bound port,
and how a remote webhook reaches a daemon that only binds loopback.

## Phase 7: autostart and consent

The last phase before anything ships. The daemon starts with the machine, and the user is asked
first. A control to stop the background server belongs here, since phases 1 to 6 deliberately
have none.

## Deferred, not scheduled

- The trigger unit list from the earlier design sketch.
- A templates library for automations. The cron templates in phase 3.5 are schedules, not prompts.
- An MCP `create_automation` tool, so an agent can write an automation.
