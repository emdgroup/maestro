---
phase: quick
plan: 260401-csx
type: execute
wave: 1
depends_on: []
files_modified:
  - src-tauri/src/ipc/execution_handlers.rs
  - src-tauri/src/ipc/filesystem_handlers.rs
  - src-tauri/src/ipc/project_handlers.rs
  - src-tauri/src/ipc/review_handlers.rs
  - src-tauri/src/ipc/settings_handlers.rs
  - src-tauri/src/ipc/ssh_handlers.rs
  - src-tauri/src/ipc/task_handlers.rs
  - src-tauri/src/ipc/worktree_handlers.rs
  - src-tauri/src/main.rs
  - src-tauri/src/models/task.rs
  - src-tauri/src/process/remote.rs
  - src-tauri/src/websocket/streaming.rs
  - src-tauri/Cargo.toml
autonomous: true
requirements: []

must_haves:
  truths:
    - "Running the Tauri app in dev mode prints backend diagnostic output to the terminal"
    - "No log:: macro calls remain in src-tauri/src/"
    - "The log and env_logger crates are removed from Cargo.toml"
    - "cargo check passes with zero errors"
  artifacts:
    - path: "src-tauri/Cargo.toml"
      provides: "log and env_logger dependencies removed"
      contains: "does NOT contain: log = "
  key_links:
    - from: "src-tauri/src/main.rs"
      to: "stderr"
      via: "eprintln! direct output (no logger init needed)"
      pattern: "eprintln!"
---

<objective>
Replace all `log::info!`, `log::warn!`, `log::debug!`, and `log::error!` macro calls across `src-tauri/src/` with direct `eprintln!` calls, then remove the `log` and `env_logger` crate dependencies from `Cargo.toml`.

Purpose: Log output from the `log` crate routes through `env_logger` and is invisible when running the compiled Tauri executable. `eprintln!` writes directly to stderr and is always visible in the terminal used to launch the app.

Output: All 150+ `log::*` calls replaced with `eprintln!`, crate dependencies removed, `cargo check` clean.
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Replace all log:: macro calls with eprintln!</name>
  <files>
    src-tauri/src/ipc/execution_handlers.rs
    src-tauri/src/ipc/filesystem_handlers.rs
    src-tauri/src/ipc/project_handlers.rs
    src-tauri/src/ipc/review_handlers.rs
    src-tauri/src/ipc/settings_handlers.rs
    src-tauri/src/ipc/ssh_handlers.rs
    src-tauri/src/ipc/task_handlers.rs
    src-tauri/src/ipc/worktree_handlers.rs
    src-tauri/src/main.rs
    src-tauri/src/models/task.rs
    src-tauri/src/process/remote.rs
    src-tauri/src/websocket/streaming.rs
  </files>
  <action>
    In every file listed above, replace all log:: macro calls with `eprintln!` using these exact mappings:
    - `log::info!(...)` → `eprintln!(...)`
    - `log::debug!(...)` → `eprintln!(...)`
    - `log::warn!(...)` → `eprintln!(...)`
    - `log::error!(...)` → `eprintln!(...)`

    The format string and arguments remain identical — only the macro name changes.

    Example:
      BEFORE: `log::info!("list_worktrees_with_status(project={}) called", project_id);`
      AFTER:  `eprintln!("list_worktrees_with_status(project={}) called", project_id);`

    Also in `src-tauri/src/main.rs`: remove the `env_logger::init();` call (line 27) since no logger
    backend is needed when using eprintln! directly.

    Do NOT add any prefix like "[INFO]" or "[WARN]" — keep messages as-is.
    Do NOT use println! — always use eprintln! so output goes to stderr.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro/src-tauri && grep -rn "log::" src/ | grep -v "models/mod.rs" | grep -v "execution_log" | wc -l</automated>
  </verify>
  <done>The command above returns 0 (zero log:: macro calls remain, excluding the execution_log re-export line in models/mod.rs which is unrelated)</done>
</task>

<task type="auto">
  <name>Task 2: Remove log and env_logger from Cargo.toml and verify build</name>
  <files>src-tauri/Cargo.toml</files>
  <action>
    In `src-tauri/Cargo.toml`, remove both dependency lines:
    - `log = "0.4"`
    - `env_logger = "0.11"`

    After removing those lines, run `cargo check` from `src-tauri/` to confirm the build is clean.
    If any remaining `use log` or `use env_logger` import lines exist in any .rs file, remove those too.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro/src-tauri && cargo check 2>&1 | tail -5</automated>
  </verify>
  <done>`cargo check` exits 0 with no errors. `grep -n "^log\|^env_logger" Cargo.toml` returns nothing.</done>
</task>

</tasks>

<verification>
After both tasks complete:

```bash
# Zero log:: calls remain (excluding unrelated execution_log re-export)
grep -rn "log::" /home/m306213/workspace/maestro/src-tauri/src/ | grep -v "models/mod.rs" | grep -v "execution_log"

# Crate dependencies gone
grep -n "^log\|^env_logger" /home/m306213/workspace/maestro/src-tauri/Cargo.toml

# Build clean
cd /home/m306213/workspace/maestro/src-tauri && cargo check
```
</verification>

<success_criteria>
- Zero `log::` macro calls in `src-tauri/src/` (150 calls replaced with eprintln!)
- `env_logger::init()` removed from `main.rs`
- `log` and `env_logger` removed from `Cargo.toml`
- `cargo check` passes with zero errors
- Backend diagnostic output is visible in the terminal when running `pnpm tauri:dev`
</success_criteria>

<output>
After completion, create `.planning/quick/260401-csx-revert-rust-logging-from-log-crate-back-/260401-csx-SUMMARY.md`
</output>
