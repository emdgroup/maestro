# External Integrations

**Analysis Date:** 2026-02-14

## APIs & External Services

**GitHub:**
- Service: GitHub Issues API (v3)
- What it's used for: Import open issues from GitHub repositories into GSD tasks
- SDK/Client: `reqwest` 0.11 (HTTP client)
- Auth: Bearer token (GitHub Personal Access Token)
- Implementation: `src-tauri/src/ipc/handlers.rs` → `sync_github_issues()` function
- Endpoint: `https://api.github.com/repos/{owner}/{repo}/issues?state=open&per_page=100`
- Task sync: Updates or creates tasks in database with `external_id` (issue number), `is_imported=true`, `import_source="github"`

**Jira:**
- Service: Jira Cloud API (v3)
- What it's used for: Import Jira issues into GSD tasks via JQL queries
- SDK/Client: `reqwest` 0.11 (HTTP client)
- Auth: Basic Auth (email + API token base64-encoded)
- Implementation: `src-tauri/src/ipc/handlers.rs` → `sync_jira_issues()` function
- Endpoint: `https://{host}/rest/api/3/search` with JQL parameter
- Task sync: Updates or creates tasks in database with `external_id`, `is_imported=true`, `import_source="jira"`

## Data Storage

**Databases:**
- SQLite 3 (bundled with `rusqlite` 0.31)
  - Connection: Platform-specific path (see STACK.md)
  - Client: `rusqlite` 0.31 (Rust driver)
  - Schema: `src-tauri/src/db/schema.rs` (8 schema versions, auto-migrated)

**File Storage:**
- Local filesystem only
- Worktrees stored as git branches in local repository clones
- Execution logs and terminal output stored in SQLite `execution_logs` table

**Caching:**
- None - SQLite is primary store
- SSH sessions cached in-memory in `AppState.ssh_sessions` (HashMap<i64, RemoteSshSession>)
- PTY sessions cached in-memory in `AppState.pty_sessions` (HashMap<i32, Arc<PtySession>>)

## Authentication & Identity

**SSH for Remote Projects:**
- Auth Provider: SSH protocol (password, public key, or key-based with agent)
- Implementation: `src-tauri/src/ssh/` module
  - Client: `ssh2` 0.9 crate
  - Session management: `RemoteSshSession` in `src-tauri/src/ssh/session.rs`
  - Password manager: `src-tauri/src/ssh/password_manager.rs` (uses system `keyring` crate)
  - Connection pool: Lazy initialization, stored per project in database
- Config storage: `SshConfig` struct stored as JSON in `projects.ssh_config` column
- Features:
  - Host key verification via `known_hosts` table
  - Password storage in system keyring (encrypted per OS)
  - Connection pooling with state tracking

**App Settings Auth:**
- No centralized identity provider
- API tokens stored in `settings` table as key-value pairs (via `AppSettings` model)
- User can configure:
  - `model_default` - Default AI model
  - `mcp_defaults` - Model context protocol defaults
  - `skills_defaults` - Default task skills

## Monitoring & Observability

**Error Tracking:**
- None detected - No Sentry, Rollbar, or similar service
- Application errors stored in `error_event` column of `execution_logs` table (JSON ErrorEvent struct)

**Logs:**
- Console logging via `println!` macros in Rust backend
- Terminal output captured in `execution_logs.terminal_output` column
- Execution logs stored in `execution_logs` table (status, output, error_event)

## CI/CD & Deployment

**Hosting:**
- Tauri 2 desktop application - self-contained executable for macOS, Windows, Linux
- No remote deployment (standalone desktop app)

**CI Pipeline:**
- Not detected - Repo may use GitHub Actions but not visible in this codebase scan

## Environment Configuration

**Required env vars for API access:**
- `GITHUB_TOKEN` - GitHub Personal Access Token (passed at runtime to `sync_github_issues()`)
- `JIRA_API_TOKEN` - Jira Cloud API token (passed at runtime to `sync_jira_issues()`)

**Secrets location:**
- System keyring for SSH passwords (via `keyring` 2.0 crate)
- GitHub/Jira tokens: Passed directly from UI (not persisted)
- Database credentials: Not applicable (local SQLite)

## Webhooks & Callbacks

**Incoming:**
- None detected

**Outgoing:**
- None detected - App is consumer of APIs, not provider of webhooks

## Remote SSH Integration

**SSH Workflow:**
1. User creates remote project with `SshConfig` (host, port, username, auth_method)
2. `RemoteSshSession` established in `src-tauri/src/ssh/session.rs`
3. SSH connection tested before project creation (see `create_project()` in handlers)
4. Lazy connection: Sessions stored in `AppState.ssh_sessions` HashMap, connected on-demand
5. Remote git operations execute commands via SSH tunnel
6. Known hosts stored in `known_hosts` SQLite table for security

**SSH Connection Storage:**
- Table: `ssh_connections` (created in schema v7 migration)
- Columns: `id`, `connection_string`, `username`, `host`, `port`, `auth_method`, `display_name`, `last_used_at`, `created_at`, `updated_at`
- Used for quick reconnection to previously used SSH servers

**Password Management:**
- System-level secure storage via `keyring` 2.0
- Function: `save_ssh_password(host, username, password)` (IPC command)
- Retrieval: Automatic by SSH client during connection attempt
- Cleanup: `delete_ssh_password()` command for account removal

## Process & Terminal Management

**Child Process Execution:**
- Async process spawning via `tokio::process::Command` (see `spawn_agent_cli_pty()`)
- NOT `std::process::Command` (blocks the async runtime)

**PTY (Pseudo-Terminal) Support:**
- Library: `portable-pty` 0.8 (cross-platform)
- Implementation: `src-tauri/src/process/pty.rs`
- Session pooling: `AppState.pty_sessions` (task_id → PtySession)
- Features:
  - Real-time terminal output streaming via Tauri `Channel<String>`
  - Terminal resizing (cols, rows)
  - Input/output handling

**Terminal Commands:**
- `attach_terminal(task_id, output_channel, include_history)` - Attach to running process
- `send_terminal_input(task_id, input)` - Send user input to terminal
- `resize_terminal(task_id, cols, rows)` - Resize terminal dimensions
- `detach_terminal(task_id)` - Disconnect from terminal

## Type Safety & Code Generation

**TypeScript Type Generation:**
- Tool: `ts-rs` 7.1 (Rust macro-based)
- Workflow:
  1. Rust structs use `#[derive(Serialize, Deserialize, TS)]` + `#[ts(export)]`
  2. Build step: `cargo build` auto-generates types
  3. Output: `src/types/bindings.ts` (auto-generated)
  4. Frontend: Import generated types for type-safe IPC calls
- Examples: `Project`, `Task`, `WorktreeStatus`, `ExecutionLog`, `SshConfig` - all in `bindings.ts`

## Platform-Specific Integrations

**Windows:**
- Accent color detection via Windows API (`windows` 0.58 crate)
- UI/Theme integration for modern Windows aesthetics

**macOS:**
- Standard platform app structure (generated by Tauri)

**Linux:**
- GTK-based window management

---

*Integration audit: 2026-02-14*
