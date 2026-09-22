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

| Phase | What                                        | State                         |
| ----- | ------------------------------------------- | ----------------------------- |
| 0     | Session identity: one opaque id everywhere  | Done, `4f08e9aa`              |
| 1     | Resident mode: daemon, `attach`, re-adopt   | Done, `0fc3a63c` + `93d2b9b7` |
| 2     | Session ownership and lifetime              | Next                          |
| 3     | `automations.db`                            | Planned                       |
| 4     | Worktree provisioning moves into the daemon | Planned                       |
| 5     | The clock                                   | Planned                       |
| 6     | Webhooks                                    | Planned                       |
| 7     | Autostart and consent                       | Planned, last before release  |

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

## Phase 2: session ownership and lifetime

Phase 1 made sessions immortal. This phase decides when they end.

Scope:

- An **interactive** session ends roughly 60 seconds after the client that started it disconnects.
- An **automation** run ends on the agent's final response.
- A session **awaiting permission** times out after around 30 minutes.
- Caps on concurrent agents and on run duration.

Already decided: **only the client that started a session sees its output.** There is no fan-out to
other clients in this design.

Worth revisiting here, having been declined for phase 1: a rolling window per session would let a
second client catch up mid-session. Only worth its memory if a second client actually exists.

Open questions for the pre-phase interview: where the timers live (daemon or host), what the caps
are and whether they are configurable, what the user sees when a cap is hit, and whether a timed-out
permission request cancels the turn or just stops waiting.

## Phase 3: `automations.db`

Replaces `.maestro/automations.json`, with a one-shot import so nothing already written is lost.

Tables: `projects`, `automations`, `runs`. Keyed by canonicalized project path, per the cross-phase
decision above.

Open: whether this is a second database file or new tables in `maestro.db`. It is the daemon's state,
not the app's, which argues for its own file next to the daemon's lock.

## Phase 4: worktree provisioning in the daemon

Moves worktree creation out of the app so a scheduled or webhook-triggered run can provision one
with no window open. The git operations already live in `src-tauri/src/git/`, so the question is what
moves and what is called over the protocol.

## Phase 5: the clock

Cron expressions with a timezone, evaluated on a 60 second tick. Each firing writes a `runs` row.
A missed occurrence is recorded as `skipped` rather than run late, per the cross-phase decision.

The app already has schedule presets and a 60 second clock from the pre-phase-0 work. This phase
moves that authority into the daemon.

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
- A templates library for automations.
- Run history in the UI, plus a needs-input badge.
- An MCP `create_automation` tool, so an agent can write an automation.
