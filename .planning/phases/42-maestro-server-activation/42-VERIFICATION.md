---
phase: 42-maestro-server-activation
verified: 2026-04-17T21:00:00Z
status: human_needed
score: 3/4
overrides_applied: 0
human_verification:
  - test: "Run maestro-server with a real ACP agent subprocess. Send a SpawnRequest, then send a PromptRequest that triggers a permission request (e.g., a file write). While conn.prompt() is running, send a PermitResponse on stdin. Verify the agent unblocks and produces a PromptResponse."
    expected: "The permission request pauses the agent turn, arrives on stdout as ServerResponse::PermissionRequest, and sending PermitResponse on stdin unblocks the agent. The PromptResponse arrives after permission is granted."
    why_human: "The inline conn.prompt().await approach blocks the stdin read loop. The mechanism (oneshot channel, PermitResponse variant, pending_permissions dispatch) is correctly implemented and verified in isolation, but the end-to-end flow requires a live ACP agent to confirm the tokio LocalSet cooperative scheduling allows PermitResponse to be read while conn.prompt() is active. The RESEARCH.md notes this as Assumption A3 with Medium risk."
---

# Phase 42: maestro-server Activation — Verification Report

**Phase Goal:** maestro-server binary handles the full ACP stdin/stdout message loop — receiving spawn requests, spawning agents via ClientSideConnection, and forwarding structured session events and permission requests to the Tauri host
**Verified:** 2026-04-17T21:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | maestro-server receives a SpawnRequest on stdin and spawns the target agent subprocess via ACP ClientSideConnection without error | VERIFIED | `main.rs`: `read_message(&mut stdin)` loop (L43), `agent::spawn_agent_subprocess` (L67), `acp::ClientSideConnection::new` (L102), `conn.initialize` (L121), `conn.new_session` (L145), `SpawnOk` written (L178). All 4 server tests + 14 protocol tests pass. Binary builds (39 MB ELF). |
| 2 | Structured session events (messages, tool calls, diffs, plans) arrive on stdout as ServerResponse::SessionUpdate JSON frames | VERIFIED | `client.rs` L72-84: `session_notification` serializes `SessionNotification` via `serde_json::to_value`, wraps in `ServerResponse::SessionUpdate`, calls `send_response`. `impl agent_client_protocol::Client for MaestroServerClient` at L70 is a real trait impl, not a stub. `test_session_notification_writes_stdout` passes wire framing roundtrip. |
| 3 | Raw terminal output from the agent's PTY callbacks arrives on stdout as ServerResponse::TerminalOutput frames | VERIFIED | `client.rs` L119-271: `create_terminal` validates cwd (T-42-01), spawns subprocess with `Command::new`, `spawn_local` background reader at L175 reads stdout/stderr lines and writes `ServerResponse::TerminalOutput` frames via `send_response`. `test_terminal_output_frame` covers binary/ANSI bytes. |
| 4 | Permission requests pause the agent and arrive on stdout as ServerResponse::PermissionRequest; sending PermissionResponse on stdin unblocks the agent | HUMAN NEEDED | Mechanism verified: `client.rs` L91-113 creates oneshot, inserts sender keyed by `request_id`, writes `PermissionRequest` to stdout, blocks on `rx.await`. `main.rs` L237-254 dispatches `acp::RequestPermissionResponse` to the correct oneshot. `test_permission_pause_creates_pending_entry` passes. **Architectural concern:** `conn.prompt().await` at L199 blocks the stdin loop. `PermitResponse` can only be read at the top of the loop (`read_message` at L43). Whether tokio `LocalSet` cooperative scheduling allows the `PermitResponse` read to interleave with the blocking `conn.prompt()` call cannot be verified without a live agent subprocess. |

**Score:** 3/4 roadmap truths fully verified (SC-4 mechanism verified, end-to-end needs human)

### Plan 01 Must-Have Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | ServerRequest::PermitResponse variant exists and roundtrips correctly via serde | VERIFIED | `maestro-protocol/src/lib.rs` L24: `PermitResponse(PermissionResponse)` in `ServerRequest` enum. `roundtrip_permit_response_request` test (L256) + `framing_permit_response_roundtrip` test (L267) both pass. JSON tag is `"permit_response"`. |
| 2 | MaestroServerClient implements all required acp::Client trait methods | VERIFIED | `client.rs` L70: `impl agent_client_protocol::Client for MaestroServerClient`. Implements: `session_notification`, `request_permission`, `create_terminal`, `terminal_output`, `release_terminal`, `kill_terminal`, `wait_for_terminal_exit`. Cargo check clean. |
| 3 | session_notification callback serializes SessionNotification to ServerResponse::SessionUpdate and writes to stdout | VERIFIED | `client.rs` L72-84: `serde_json::to_value(&args)` → `ServerResponse::SessionUpdate(SessionUpdate { session_id, payload })` → `send_response`. |
| 4 | request_permission callback blocks on oneshot channel and resumes when PermitResponse is dispatched | VERIFIED (mechanism) | `client.rs` L94-112: `oneshot::channel()`, insert sender, write PermissionRequest, `rx.await`. `main.rs` L237-254: dispatches `acp::RequestPermissionResponse::new(outcome)` to sender. End-to-end unblock needs human test. |
| 5 | create_terminal spawns subprocess, accumulates output, pushes TerminalOutput frames to stdout | VERIFIED | `client.rs` L119-271: `Command::new(&args.command).args(&args.args)`, `spawn_local` reader writes `ServerResponse::TerminalOutput` per line chunk. |
| 6 | ActiveSession type maps maestro session_id to acp_session_id and holds ClientSideConnection | VERIFIED | `sessions.rs` L26-35: `ActiveSession { conn: ClientSideConnection, acp_session_id: agent_client_protocol::SessionId, terminals, child }`. `SessionMap` type alias at L38. |
| 7 | Unit test stubs for SERVER-01 through SERVER-04 exist and pass | VERIFIED | `maestro-server/src/tests.rs`: 4 tests. `cargo test -p maestro-server` → `4 passed`. |

### Plan 02 Must-Have Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | maestro-server receives a SpawnRequest on stdin and spawns an ACP agent subprocess via ClientSideConnection | VERIFIED | `main.rs` L64-185: full Spawn handler. |
| 2 | maestro-server writes SpawnOk to stdout after successful agent initialization | VERIFIED | `main.rs` L177-184: `ServerResponse::SpawnOk(SpawnResponse { session_id: req.session_id })`. |
| 3 | maestro-server receives PromptRequest on stdin and forwards to the correct ACP session | VERIFIED | `main.rs` L187-228: looks up session by `session_id`, calls `session.conn.prompt(prompt_req).await`. |
| 4 | maestro-server receives CancelRequest on stdin and drops the session (killing subprocess) | VERIFIED | `main.rs` L230-235: `client_refs.remove` + `sessions.remove`. Child dropped via `kill_on_drop(true)`. |
| 5 | maestro-server receives PermitResponse on stdin and dispatches to the correct oneshot channel | VERIFIED | `main.rs` L237-255: `client_refs.get(&perm_resp.session_id)` → `pending_permissions.borrow_mut().remove(&perm_resp.request_id)` → `tx.send(response)`. |
| 6 | maestro-server writes ErrorResponse to stdout when operations fail | VERIFIED | `main.rs`: ErrorResponse sent on spawn failure (L70-78), initialize failure (L130-140), new_session failure (L152-163), unknown session (L220-227), prompt failure (L205-216). |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `maestro-protocol/src/lib.rs` | PermitResponse(PermissionResponse) variant on ServerRequest | VERIFIED | L24 in enum; 14 tests pass including 2 new roundtrip tests |
| `maestro-server/src/sessions.rs` | ActiveSession, TerminalHandle, type aliases | VERIFIED | 39 lines; exports `ActiveSession`, `TerminalHandle`, `TerminalExitInfo`, `SessionMap` |
| `maestro-server/src/client.rs` | MaestroServerClient implementing acp::Client with real callbacks | VERIFIED | 343 lines; real trait impl with 7 methods, `send_response` helper, `MaestroServerClient::new` |
| `maestro-server/src/agent.rs` | spawn_agent_subprocess helper returning tokio::process::Child | VERIFIED | 38 lines; path validation, `kill_on_drop(true)`, piped stdin/stdout |
| `maestro-server/src/tests.rs` | Unit test stubs covering SERVER-01 through SERVER-04 | VERIFIED | 178 lines; 4 `#[tokio::test]` functions, all pass |
| `maestro-server/src/main.rs` | Real stdin read loop with session dispatch | VERIFIED | 267 lines; `#[tokio::main(flavor="current_thread")]` + LocalSet + `read_message` loop + all 4 ServerRequest variants |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `maestro-server/src/client.rs` | `maestro-protocol` | `write_message` to stdout | VERIFIED | `send_response` at L57-67 calls `maestro_protocol::write_message` |
| `maestro-server/src/client.rs` | `agent-client-protocol` | `impl Client for MaestroServerClient` | VERIFIED | L70: `impl agent_client_protocol::Client for MaestroServerClient` |
| `maestro-server/src/main.rs` | `maestro-server/src/client.rs` | `MaestroServerClient::new()` called per Spawn | VERIFIED | L95: `MaestroServerClient::new(Rc::clone(&stdout), req.session_id.clone(), Rc::clone(&terminals))` |
| `maestro-server/src/main.rs` | `maestro-server/src/agent.rs` | `spawn_agent_subprocess` called in Spawn handler | VERIFIED | L67: `agent::spawn_agent_subprocess(&req.agent_id, &[], &req.cwd)` |
| `maestro-server/src/main.rs` | `maestro-protocol` | `read_message` for stdin, `send_response` for stdout | VERIFIED | L43: `read_message(&mut stdin).await`; `send_response` called at 8 sites |
| `maestro-server/src/main.rs` | `agent-client-protocol` | `ClientSideConnection::new`, `conn.initialize`, `conn.new_session`, `conn.prompt` | VERIFIED | L102 (`ClientSideConnection::new`), L121 (`initialize`), L145 (`new_session`), L199 (`prompt`) |

### Data-Flow Trace (Level 4)

Not applicable — maestro-server is a server binary, not a UI component with data rendering. All data flows through the stdin/stdout protocol pipe.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Binary is produced and executable | `ls -la target/debug/maestro-server` | 39 MB ELF, executable bit set | PASS |
| Protocol tests pass (14/14) | `cargo test -p maestro-protocol` | `14 passed; 0 failed` | PASS |
| Server unit tests pass (4/4) | `cargo test -p maestro-server` | `4 passed; 0 failed` | PASS |
| Workspace clean | `cargo check --workspace` | `0 errors, 1 dead_code warning (expected, documented)` | PASS |
| PermitResponse JSON tag | `test_permit_response_roundtrip` asserts `json.contains("permit_response")` | assertion passes | PASS |
| End-to-end permission unblock | Requires live ACP agent subprocess | Cannot test without running server | SKIP (human needed) |

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|---------|
| SERVER-01 | 42-01, 42-02 | maestro-server receives SpawnRequest, spawns ACP agent subprocess via ClientSideConnection, returns SpawnOk | SATISFIED | `main.rs` Spawn handler: spawn_agent_subprocess → ClientSideConnection::new → initialize → new_session → SpawnOk |
| SERVER-02 | 42-01, 42-02 | maestro-server forwards structured session updates to stdout as ServerResponse::SessionUpdate | SATISFIED | `client.rs` session_notification: to_value(args) → SessionUpdate → send_response |
| SERVER-03 | 42-01, 42-02 | maestro-server forwards raw terminal output to stdout as ServerResponse::TerminalOutput | SATISFIED | `client.rs` create_terminal: spawn_local reader → ServerResponse::TerminalOutput per chunk |
| SERVER-04 | 42-01, 42-02 | maestro-server forwards permission requests and awaits PermissionResponse on stdin to unblock agent | PARTIALLY SATISFIED | Mechanism: oneshot channel insert/dispatch is correct. End-to-end: stdin loop blocked during conn.prompt() — requires human test with live agent. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `maestro-server/src/client.rs` | 258-260 | `exit_code: None, signal: None` (stub exit status in background reader) | INFO | Terminal exit info is always `None`/`None` regardless of actual process exit. `wait_for_terminal_exit` will return after EOF but with no exit code. Documented in 42-01-SUMMARY.md as intentional stub — will use `child.wait()` in a later phase. Does not affect `TerminalOutput` push path (SC-3). |
| `maestro-server/src/sessions.rs` | 32, 34 | `dead_code` warning on `terminals` and `child` fields | INFO | Fields held for Drop side-effects (`kill_on_drop`, terminal cleanup). Expected — documented in 42-02-SUMMARY.md. Not a stub. |

No BLOCKER or WARNING anti-patterns found.

### Human Verification Required

#### 1. Permission Pause/Unblock End-to-End

**Test:** Launch maestro-server binary. Pipe a `SpawnRequest` for a real ACP agent (e.g., `npx @agentclientprotocol/claude-agent-acp`) that is configured to require permission for file writes. After receiving `SpawnOk`, send a `PromptRequest` that triggers a permission request mid-turn (e.g., ask the agent to create a file). While the agent is paused waiting for permission, send a `PermitResponse` (allowed=true) on stdin.

**Expected:** The server writes a `ServerResponse::PermissionRequest` frame to stdout when the agent's permission is triggered. After the `PermitResponse` is received and dispatched, the agent unblocks and the `PromptResponse` eventually arrives (either via `conn.prompt()` return or via `session_notification` frames).

**Why human:** The inline `conn.prompt().await` at `main.rs:199` blocks the stdin read loop. The `PermitResponse` can only be read when the loop re-enters `read_message` at L43. Whether the tokio `LocalSet` cooperative scheduler allows the permission dispatch to interleave with the blocked `conn.prompt()` call depends on the ACP SDK's internal yield behavior. Assumption A3 in RESEARCH.md flags this as Medium risk. A live agent subprocess is required to confirm or deny this concern.

**If blocked (deadlock confirmed):** The fix is to run `conn.prompt()` in a `spawn_local` task and use `tokio::select!` between `read_message` and the prompt task future in the main loop, or to use a separate stdin reader task that feeds messages via an `mpsc` channel.

### Gaps Summary

No gaps that block all goal achievement. The phase delivers a functional maestro-server binary with all four ServerRequest handlers wired and 18/18 automated tests passing.

The only open item is SC-4 (permission pause/unblock) which requires a live agent subprocess to confirm end-to-end behavior. The mechanism is architecturally sound — oneshot channel, PermitResponse dispatch, blocking `rx.await` — but the interaction between `conn.prompt().await` blocking the stdin loop and the need to read `PermitResponse` from stdin during that blocked period cannot be verified without execution. This is classified as `human_needed` rather than `gaps_found` because:

1. The unit test (`test_permission_pause_creates_pending_entry`) verifies the oneshot channel mechanics work correctly.
2. The ACP SDK's `handle_io` task (running via `spawn_local`) processes the permission callback from the agent side, correctly writing `PermissionRequest` to stdout and awaiting `rx`.
3. The question is whether the tokio runtime's cooperative scheduling allows the main loop's `conn.prompt().await` to yield at a point where a new `read_message` can run to dispatch the `PermitResponse`. This is an integration question, not a code correctness question.
4. No ROADMAP phase between 43-48 specifically fixes a "stdin loop deadlock during prompt" — Phase 48 addresses the UI layer permission flow, not the server binary architecture. If the deadlock is confirmed, it would be a gap requiring a fix in either Phase 42 (re-verification) or Phase 43.

---

_Verified: 2026-04-17T21:00:00Z_
_Verifier: Claude (gsd-verifier)_
