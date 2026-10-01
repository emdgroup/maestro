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

**Every window attaches at once.** The host matches replies by type, not by request id, so the
sink routes: a reply goes to the window that asked, a message naming a session goes to that
session's owner (the window that last sent a request naming it), and anything unowned or
unprompted goes to every window. A window receiving a session it does not hold parks it, and
answers a `HostToolCall` only for a session it holds, so two windows never both answer one call.

**Sessions are re-adopted, not reloaded.** `SpawnRequest` and `SessionLoadRequest` carry
`host_meta`, an opaque blob the server stores and never reads, holding what the host knows and the
server does not (project, task, session name, connection). `ListLiveSessions` hands it back, and
`session_ops::adopt_live_sessions` rebuilds a host-side entry for each session belonging to the
project being opened. It runs in `prime_project_server` _before_ the snapshot restore, so
`restore_acp_session`'s existing "already live" guard returns the adopted session rather than
loading a second copy of the same conversation.

**A session between turns is closed and reloaded instead**, which is the only way to recover the
transcript it produced while nobody was attached: the agent keeps its own history, and
`session/load` is what replays it. `ListLiveSession.turn_active` is what decides — closing a
session mid-turn throws the turn away, so those are adopted as they are and their transcript
begins at the reconnect. Do **not** issue `session/load` against a live session without closing it
first: `maestro-server` would replace its own map entry while the displaced command loop kept
running, leaving an agent nothing routes to and nothing stops.

**A session nobody is watching does not live forever.** `main::reap_idle_sessions` sweeps every
`IDLE_SWEEP` (60 seconds) on its own interval, and it is mark-and-close rather than a deadline: a
session found idle with no client attached is marked, and closed by the next sweep if it is still
both. Any activity in between clears the mark and the session starts over, so a session survives
between one and two minutes after the last client leaves. Idle means `turn_active` is false, so a
session working through a prompt finishes it whether or not anyone is there, and is only marked
once it is done. The close goes through the session's own command loop rather than aborting its
task, because `session/close` is what leaves the agent holding a transcript `session/load` can
replay — an agent without `session/load` loses that transcript, which is the accepted price of not
keeping an unbounded number of agent processes alive. A reopen before the second sweep re-adopts
the session as it stands; a later one pays a `session/load`.

**An unanswered prompt survives the client it was shown to.** A session blocked on a permission or
elicitation request is mid-turn by definition, so the reaper never takes it. The request itself is
stored beside its `oneshot` sender (`PendingPermissions` / `PendingElicitations` in `sessions.rs`)
and handed back in `ListLiveSession.pending_requests`, because the message that asked went to a
client that is gone. `adopt_live_sessions` replays each one through
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
  its session: the daemon writes no `host_meta`, having nothing of the host's to write, so
  `adopt_live_sessions` asks for the project's running runs and adopts the sessions they name.
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

**Prompts are app-side too, and not templates.** A prompt is text the user copies into an agent:
title, body, tags, a favorite flag. `src-tauri/src/prompts.rs` keeps them in the app's `prompts`
table rather than in `.maestro/`, because a **shared** prompt belongs to no project and has to be
listed in every one: shared is `project_id IS NULL`, and unsharing hands the prompt to the project
it was unshared from. Favoriting goes through its own command so it leaves `updated_at`, and the
list order, alone.

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
- `src-tauri/src/acp/host_tools.rs` — the host end: the task tools and `canvas_await`, with the
  automation and template tools in `acp/automation_tools.rs` and the prompt tools in `prompts.rs`.

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
| `create_task` / `list_tasks`                      | the host, against the database                 | the task, or the list         |
| `get_task` / `update_task` / `comment_task`       | the host, scoped to the session's project      | the task, or the new entry    |
| automation and run tools (`*_automation*`)        | the host, scoped to the session's project      | the automation, or the run    |
| template tools (`*_template*`)                    | the host, app-wide; built-ins are read-only    | the template                  |
| prompt tools (`*_prompt*`)                        | the host, the project's own and shared ones    | the prompt, or the list       |

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
`host_tools::handle`. The entry's `description` is the _only_ documentation the agent gets — it
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
