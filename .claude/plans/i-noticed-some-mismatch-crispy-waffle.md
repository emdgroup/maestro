# Plan: Rust Backend Domain Restructuring

## Context

src-tauri (18.7k lines, 74 files) and maestro-server (3.3k lines, 10 files) have outgrown their current organization. Three files exceed 2000 lines. maestro-server has no module structure. Handlers live in a monolithic `ipc/` folder disconnected from the domain logic they coordinate. Goal: domain-driven file organization where each domain owns its handlers, models, and internal logic.

## Conventions

1. **Flat file first** — module stays single file until ~400 lines or 2+ distinct responsibilities
2. **Directory module trigger** — split into dir/mod.rs + named submodules
3. **No logic in mod.rs** — declarations and re-exports only
4. **File size ceiling** — target ≤500 lines. Flag >300. Split at >600.
5. **Handlers co-located with domain** — no monolithic `ipc/` folder
6. **Models co-located with domain** — no monolithic `models/` folder
7. **Naming** — `snake_case.rs` files, `PascalCase` types, `snake_case` functions (unchanged)

---

## Target Structure: src-tauri

```
src-tauri/src/
├── main.rs                              (entry point — 73 lines, unchanged)
├── lib.rs                               (module tree + collect_commands! — update mod paths)
├── error.rs                             (shared error types — 31 lines)
│
├── core/                                ← App infrastructure
│   ├── mod.rs                           (re-exports)
│   ├── state.rs                         (AppState, SshState, AcpState, PtyState from db/connection.rs)
│   ├── db.rs                            (init_db, SQLite pool, WAL config, busy_timeout)
│   ├── schema.rs                        (table definitions, migrations — from db/schema.rs)
│   ├── settings.rs                      (settings persistence — from db/settings.rs)
│   └── project_storage.rs              (.maestro/ folder I/O — from db/project_storage.rs)
│
├── project/                             ← Project lifecycle domain
│   ├── mod.rs                           (re-exports)
│   ├── handlers.rs                      (IPC commands — from ipc/project_handlers.rs)
│   ├── lock.rs                          (file-based locking — from project_lock.rs)
│   └── models.rs                        (Project, ProjectConfig, ProjectStatus — from models/project.rs)
│
├── task/                                ← Task management domain
│   ├── mod.rs
│   ├── handlers.rs                      (IPC commands — from ipc/task_handlers.rs, 715 lines)
│   └── models.rs                        (Task, TaskStatus, TaskPriority, relationships — from models/task.rs)
│
├── execution/                           ← Agent execution domain
│   ├── mod.rs
│   ├── handlers.rs                      (IPC: spawn, stop, list — from ipc/execution_handlers.rs)
│   ├── process.rs                       (local vs remote dispatch — from process/mod.rs)
│   ├── pty.rs                           (local PTY spawning — from process/pty.rs)
│   ├── remote.rs                        (SSH-based exec — from process/remote.rs)
│   ├── streaming.rs                     (WebSocket relay — from streaming/streaming.rs)
│   └── models.rs                        (Worktree, WorktreeWithStatus — from models/worktree.rs)
│
├── acp/                                 ← ACP session orchestration (split from 2202-line manager.rs)
│   ├── mod.rs                           (re-exports + ConnectionKey enum)
│   ├── session_handlers.rs              (IPC: spawn, close, restore — from acp_handlers lines 119-346)
│   ├── prompt_handlers.rs               (IPC: prompts, permissions, elicitation — lines 348-565)
│   ├── discovery_handlers.rs            (IPC: agent detection, preflight — lines 567-1077)
│   ├── file_handlers.rs                 (IPC: file search/read via ACP — lines 1111-1275)
│   ├── meta_handlers.rs                 (IPC: session list/rename, replay, attachments — lines 1277-1989)
│   ├── lifecycle.rs                     (process spawn/shutdown — manager.rs lines 365-636)
│   ├── shared_server.rs                 (connection server orchestration — manager.rs lines 1682-2002)
│   ├── reader.rs                        (background reader tasks — manager.rs lines 778-859)
│   ├── cache.rs                         (agent cache management — manager.rs lines 1229-1362)
│   ├── restore.rs                       (session restoration post-reconnect — manager.rs lines 2071-2201)
│   ├── deploy.rs                        (remote agent deployment — 184 lines, unchanged)
│   └── transport.rs                     (handshake, framing — manager.rs lines 260-360)
│
├── git/                                 ← Git & worktree domain
│   ├── mod.rs                           (re-exports)
│   ├── worktree_handlers.rs             (IPC: create/delete/list worktrees — from ipc/worktree_handlers.rs)
│   ├── review_handlers.rs               (IPC: review feedback, merge — from ipc/review_handlers.rs)
│   ├── operations.rs                    (dispatch: local vs remote — from git/mod.rs lines 41-256)
│   ├── local.rs                         (local git commands — from git/mod.rs lines 259-475)
│   ├── remote.rs                        (remote helpers, shell quoting — unchanged)
│   ├── merge.rs                         (squash_merge_to_main — from git/mod.rs lines 477-572)
│   └── models.rs                        (DiffTarget, ReviewFeedback, ReviewComment — from models/review.rs + models/diff.rs)
│
├── connectivity/                        ← SSH, WSL, SFTP, filesystem browsing
│   ├── mod.rs
│   ├── ssh_handlers.rs                  (IPC: connect, auth, disconnect — from ipc/ssh_handlers.rs)
│   ├── sftp_handlers.rs                 (IPC: file transfer — from ipc/sftp_handlers.rs)
│   ├── wsl_handlers.rs                  (IPC: WSL — from ipc/wsl_handlers.rs)
│   ├── filesystem_handlers.rs           (IPC: dir listing, drives — from ipc/filesystem_handlers.rs)
│   ├── ssh/
│   │   ├── mod.rs
│   │   ├── session.rs                   (PTY session management — ssh/session.rs lines 239-549, ~300 lines)
│   │   ├── pty.rs                       (spawn_remote_pty — ssh/session.rs lines 761-904)
│   │   ├── reconnect.rs                 (reconnect_if_needed — ssh/session.rs lines 708-754)
│   │   ├── heartbeat.rs                 (spawn_heartbeat_task — ssh/session.rs lines 959-1103)
│   │   ├── types.rs                     (SshPtyHandle, SshConnectionState, enums — lines 20-227)
│   │   ├── password_manager.rs          (unchanged — 73 lines)
│   │   └── error.rs                     (unchanged — 51 lines)
│   ├── sftp.rs                          (SFTP client — from ssh/sftp.rs, 182 lines)
│   ├── wsl.rs                           (WSL detection — from wsl.rs, 172 lines)
│   └── models.rs                        (GitConnection, SshConnection, WslConnection — from models/connection.rs)
│
├── integration/                         ← External service integrations
│   ├── mod.rs
│   ├── handlers.rs                      (IPC: CRUD integrations — from ipc/integration_handlers.rs)
│   ├── lookup_handlers.rs               (IPC: search repos/projects — from ipc/integration_lookup_handlers.rs)
│   ├── issue_tracking_handlers.rs       (IPC: per-project config — from ipc/issue_tracking_handlers.rs)
│   ├── keychain.rs                      (credential storage — from issue_tracking/keychain.rs)
│   ├── token_manager.rs                 (credential lifecycle — from issue_tracking/token_manager.rs)
│   ├── models.rs                        (IntegrationStatus, IssueTrackingConfig, RemoteIssue)
│   └── providers/
│       ├── mod.rs                       (HTTP client builder, shared helpers)
│       ├── github.rs                    (226 lines)
│       ├── gitlab.rs                    (276 lines)
│       ├── jira_cloud.rs                (261 lines)
│       ├── linear.rs                    (351 lines)
│       ├── azure_devops.rs              (371 lines)
│       ├── bitbucket.rs                 (147 lines)
│       ├── forgejo.rs                   (203 lines)
│       └── gitea.rs                     (187 lines)
│
├── settings/                            ← App-wide settings
│   ├── mod.rs
│   ├── handlers.rs                      (IPC: get/save — from ipc/settings_handlers.rs)
│   └── models.rs                        (AppSettings — from models/settings.rs)
│
└── command_ext.rs                       (Windows console suppression — 37 lines)
```

**Deleted:**
- `process/spawner.rs` (dead 9-line stub)
- `streaming/` directory (collapsed into `execution/streaming.rs`)
- `ipc/` directory (handlers distributed to domains)
- `models/` directory (models distributed to domains)
- `db/` directory (moved to `core/`)

---

## Target Structure: maestro-server

```
maestro-server/src/
├── main.rs                              (entry + message loop — shrink to ~300 lines)
├── dispatch.rs                          (message routing — extract from main.rs ~400 lines)
├── command_ext.rs                       (unchanged — 22 lines)
│
├── session/
│   ├── mod.rs                           (re-exports)
│   ├── lifecycle.rs                     (spawn, close, list — from session_handler.rs lines 1-400)
│   ├── request.rs                       (prompt routing, permission, elicitation — lines 400-900)
│   └── response.rs                      (aggregation, streaming — lines 900-1348)
│
├── agent/
│   ├── mod.rs                           (re-exports)
│   ├── detection.rs                     (agent discovery — from detection.rs, 349 lines)
│   ├── registry.rs                      (session registry — from registry.rs, 171 lines)
│   └── spawn.rs                         (subprocess launch — from agent.rs, 50 lines)
│
├── terminal.rs                          (unchanged — 185 lines)
├── file_ops.rs                          (unchanged — 131 lines)
└── sessions.rs                          (session map storage — unchanged, 138 lines)
```

---

## Target Structure: maestro-protocol

No changes. Single `lib.rs` (1018 lines) appropriate for focused protocol definition crate.

---

## lib.rs Module Declarations (After)

```rust
pub mod core;
pub mod project;
pub mod task;
pub mod execution;
pub mod acp;
pub mod git;
pub mod connectivity;
pub mod integration;
pub mod settings;
pub mod error;
mod command_ext;
```

`collect_commands![]` stays in `lib.rs` — just update paths from `ipc::handler_name` to `domain::handlers::handler_name`.

---

## Migration Phases

Each phase compiles independently (`cargo check` passes).

### Phase 1: Create `core/` from `db/`
- Move `db/connection.rs` → `core/state.rs` (rename struct accessors as needed)
- Move `db/schema.rs` → `core/schema.rs`
- Move `db/settings.rs` → `core/settings.rs`
- Move `db/project_storage.rs` → `core/project_storage.rs`
- Extract `init_db()` → `core/db.rs`
- Update `lib.rs`: replace `pub mod db` with `pub mod core`
- Update all `use crate::db::` imports → `use crate::core::`

### Phase 2: Create `project/` and `task/`
- Move `ipc/project_handlers.rs` → `project/handlers.rs`
- Move `project_lock.rs` → `project/lock.rs`
- Move `models/project.rs` → `project/models.rs`
- Move `ipc/task_handlers.rs` → `task/handlers.rs`
- Move `models/task.rs` → `task/models.rs`
- Update `lib.rs` and `collect_commands![]` paths

### Phase 3: Create `connectivity/`
- Move `ssh/` → `connectivity/ssh/`
- Move `wsl.rs` → `connectivity/wsl.rs`
- Move `ipc/ssh_handlers.rs` → `connectivity/ssh_handlers.rs`
- Move `ipc/sftp_handlers.rs` → `connectivity/sftp_handlers.rs`
- Move `ipc/wsl_handlers.rs` → `connectivity/wsl_handlers.rs`
- Move `ipc/filesystem_handlers.rs` → `connectivity/filesystem_handlers.rs`
- Move `models/connection.rs` → `connectivity/models.rs`
- Update imports

### Phase 4: Create `git/`
- Move `git/mod.rs` logic → `git/operations.rs` + `git/local.rs` + `git/merge.rs`
- Move `git/remote.rs` → `git/remote.rs`
- Move `ipc/worktree_handlers.rs` → `git/worktree_handlers.rs`
- Move `ipc/review_handlers.rs` → `git/review_handlers.rs`
- Move `models/review.rs` + `models/diff.rs` → `git/models.rs`
- Move `models/worktree.rs` → `execution/models.rs` (worktree is execution domain)

### Phase 5: Create `execution/`
- Move `process/` contents → `execution/process.rs` + `execution/pty.rs` + `execution/remote.rs`
- Move `streaming/streaming.rs` → `execution/streaming.rs`
- Move `ipc/execution_handlers.rs` → `execution/handlers.rs`
- Delete `process/spawner.rs`, `streaming/` directory

### Phase 6: Create `integration/`
- Move `issue_tracking/` → `integration/providers/`
- Move `issue_tracking/keychain.rs` → `integration/keychain.rs`
- Move `issue_tracking/token_manager.rs` → `integration/token_manager.rs`
- Move `ipc/integration_handlers.rs` → `integration/handlers.rs`
- Move `ipc/integration_lookup_handlers.rs` → `integration/lookup_handlers.rs`
- Move `ipc/issue_tracking_handlers.rs` → `integration/issue_tracking_handlers.rs`
- Move `models/integration.rs` + `models/issue_tracking.rs` → `integration/models.rs`

### Phase 7: Create `settings/`
- Move `ipc/settings_handlers.rs` → `settings/handlers.rs`
- Move `models/settings.rs` → `settings/models.rs`
- Delete empty `ipc/`, `models/`, `db/` directories

### Phase 8: Split oversized files in `acp/`
- Split `acp/manager.rs` (2202 lines) into:
  - `acp/lifecycle.rs` — process spawn/shutdown (lines 365-636)
  - `acp/shared_server.rs` — connection server + queries (lines 1682-2002, 1804-1929)
  - `acp/reader.rs` — reader tasks (lines 778-859)
  - `acp/cache.rs` — agent cache (lines 1229-1362)
  - `acp/restore.rs` — session restoration (lines 2071-2201)
  - `acp/transport.rs` — framing/handshake (lines 260-360)
- Split `ipc/acp_handlers.rs` (2053 lines) into domain handlers already placed in Phase 7 cleanup:
  - `acp/session_handlers.rs` — spawn/close/load (lines 119-346)
  - `acp/prompt_handlers.rs` — send prompt, permissions, interrupt (lines 348-565)
  - `acp/discovery_handlers.rs` — preflight, detect, discover (lines 567-1077)
  - `acp/file_handlers.rs` — file search/read (lines 1111-1275)
  - `acp/meta_handlers.rs` — session list/rename, replay, attachments (lines 1277-1989)

### Phase 9: Split SSH session (in `connectivity/ssh/`)
- Split `session.rs` (1174 lines) into:
  - `types.rs` — SshPtyHandle, enums, data structures (lines 20-227)
  - `session.rs` — connection lifecycle + execution (lines 239-654)
  - `pty.rs` — spawn_remote_pty (lines 761-904)
  - `heartbeat.rs` — spawn_heartbeat_task (lines 959-1103)
  - `reconnect.rs` — reconnect_if_needed (lines 708-754)

### Phase 10: Restructure maestro-server
- Extract `dispatch.rs` from `main.rs` (message routing logic)
- Create `session/` directory, split `session_handler.rs`:
  - `session/lifecycle.rs`
  - `session/request.rs`
  - `session/response.rs`
- Create `agent/` directory:
  - Move `detection.rs` → `agent/detection.rs`
  - Move `registry.rs` → `agent/registry.rs`
  - Move `agent.rs` → `agent/spawn.rs`

---

## Verification (per phase)

1. `cargo check` — compiles after each phase
2. `cargo test` — all tests pass (move test modules with source)
3. After all phases: `pnpm tauri:gen` — bindings still generate correctly
4. Final: `pnpm tauri:dev` — app starts normally

---

## Scope Boundaries

**In scope:** File moves, module reorganization, import updates, oversized file splits.

**NOT in scope:** Functional changes, API changes, new features, logic refactoring. Every function body stays identical — this is purely structural.
