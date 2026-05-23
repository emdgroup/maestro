# Plan: Commit Pending Changes

## Context

36 modified + ~30 untracked files spanning multiple independent feature areas from recent work. Changes need organized into logical commits matching the project's established `type(scope): message` convention.

## Issues to Resolve Before Committing

**Debug `eprintln!` in Rust (needs decision):**
- `src-tauri/src/ipc/acp_handlers.rs:327-333` — 2 eprintlns in `send_prompt_impl` logging log_id, content, and result
- `maestro-server/src/registry.rs:44-55` — 3 eprintlns in `normalize_binary_cmd` logging raw cmd, filename, which result

These conflict with CLAUDE.md "No Rust Logging" rule. **Remove before committing unless intentionally kept for debugging.**

**Files to skip (not commit):**
- `role-framework.html`, `role-framework.md` — HR/career docs, unrelated to codebase
- `.previews/` — empty directory

## Proposed Commit Groups

### Commit 1 — SSH reliability
**Files:** `src-tauri/src/ssh/session.rs`
- Add 10s timeout to `open_handle` TCP connect
- Heartbeat owns reconnection — `ensure_connected` waits for heartbeat instead of racing it
- Reconnect delays tuned for network transitions: `[3, 6, 12, 24, 45]` secs

```
fix(ssh): add connection timeout and delegate reconnect to heartbeat
```

### Commit 2 — maestro-server registry binary path fix
**Files:** `maestro-server/src/registry.rs`, `maestro-server/src/agent.rs`, `maestro-server/src/main.rs`, `maestro-server/src/session_handler.rs`
- `normalize_binary_cmd` extracts filename from relative paths like `./dist-package/cursor-agent`, resolves via `which`
- Fixes agent spawn for binary entries using archive-relative paths
- Adds unit tests for filename extraction

```
fix(maestro-server): normalize registry binary paths via which
```

### Commit 3 — Clipboard image paste
**Files:** `src-tauri/src/ipc/acp_handlers.rs` (save_clipboard_image cmd), `src-tauri/src/lib.rs`, `src/components/execution/activity/ComposeBar.tsx`, `src/types/bindings.ts`
- New IPC: `save_clipboard_image(base64_data, mime_type) → tmp_path`
- ComposeBar intercepts paste events, extracts image files, saves via IPC, adds as attachments
- Only activates when `promptCapabilities.image` enabled

```
feat: add clipboard image paste support in ComposeBar
```

### Commit 4 — Agent activity UI
**Files:** `src/store/sessionActivityStore.ts`, `src/components/execution/AgentMonitor.tsx`, `src/components/execution/AgentActivityPanel.tsx`, `src/components/execution/activity/ActivityUserMessage.tsx`, `src/components/execution/activity/SubagentCard.tsx`, `src/components/execution/SpawnSessionDialog.tsx`, `src/components/execution/activity/ComposeBar.tsx` (onContentChange)
- `seen` field on `SessionActivityInfo` + `markSeen` action
- Idle status resets `seen = false` → green pulse dot + "Done" label until viewed
- Status color swap: thinking=purple, acting=info (was reversed)
- Status dot only rendered for ACP sessions

```
fix(agent-monitor): add seen state for idle sessions, fix status dot colors
```

### Commit 5 — Worktree diff delete UX
**Files:** `src/components/execution/DiffActionBar.tsx`, `src/components/execution/WorktreeDiffPanel.tsx`
- `DiffActionBar` accepts `deleteDialogOpen`, `onDeleteDialogOpenChange`, `isDeleting`, `deleteError` props
- Dialog shows loading spinner + "Deleting…" title during operation
- Shows error with "Retry" action on failure; Cancel disabled during delete

```
fix(diff-action-bar): add loading state and error handling for file delete
```

### Commit 6 — Project picker + integration UI (phase 55 continuation)
**Files:** `src/components/project-picker/ProjectPicker.tsx`, `src/components/project-picker/IntegrationsTab.tsx`, `src/components/project-picker/IntegrationConnectDialog.tsx`, `src/components/project-picker/ConnectionList.tsx`, `src/components/common/SettingsPage.tsx`, `src/App.tsx`, `src-tauri/src/ipc/integration_handlers.rs`, `src-tauri/src/ticketing/github.rs`, `src-tauri/src/acp/manager.rs`, `src/types/bindings.ts`, `package.json`, `pnpm-lock.yaml`
- ProjectPicker replaces shadcn `Tabs` with custom animated tab nav (matches AppHeader style)
- Framer Motion slide animations between tabs
- `simple-icons` dep added for provider icons in IntegrationConnectDialog
- Integration UI fixes

```
feat(55): replace Tabs with animated nav in ProjectPicker, fix integration UI
```

### Commit 7 — Docs
**Files:** `CLAUDE.md`
- Add ast-grep guidance: language flags, working patterns, known quirks (arrow function matching, tsx vs ts, multi-line fn params)

```
docs: add ast-grep guidance and known quirks to CLAUDE.md
```

### Commit 8 — Planning docs
**Files:** `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/phases/53-api-key-auth/53-CONTEXT.md`, `.planning/phases/55-settings-ui/55-*.md` (modified), all new `.planning/phases/*/` files (52, 53, 54, 55 phase artifacts), `.maestro/settings.json`, `.claude/plans/` files

```
docs(planning): update phase docs, STATE, ROADMAP
```

## Verification

After committing:
```bash
git log --oneline -10   # verify commit messages
cargo check             # verify Rust compiles
pnpm test               # verify frontend tests pass
```

## Open Question

Remove the debug `eprintln!` statements before committing? They log sensitive data (prompt content) to stderr and conflict with CLAUDE.md "No Rust Logging" rule.
