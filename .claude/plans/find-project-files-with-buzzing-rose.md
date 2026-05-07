# Refactoring Analysis: Files Over 500 Lines

## Summary

Ranked by refactoring urgency (severity of structural issues):

### CRITICAL — Needs Refactoring

| File | Lines | Problem |
|------|------:|---------|
| `maestro-server/src/session_handler.rs` | 1257 | Two monster functions: `spawn_acp_session` (524 lines!) and `load_acp_session` (474 lines). Single functions doing too much — orchestration, IO, error handling, state management all interleaved. |
| `src/components/execution/WorktreeDiffPanel.tsx` | 752 | One 697-line component function. Entire file is basically one giant render. Needs extraction into sub-components (diff header, file tree, hunk renderer, etc). |

### HIGH — Would Benefit From Splitting

| File | Lines | Problem |
|------|------:|---------|
| `src-tauri/src/ipc/acp_handlers.rs` | 1420 | 1420 lines but no single function over 112 lines — it's many IPC handlers in one file. Natural split: session lifecycle handlers vs query/list handlers vs model/config handlers. |
| `src-tauri/src/acp/manager.rs` | 736 | `handle_server_message` at 157 lines is a large match/dispatch. Could extract message handlers into separate functions. `spawn_acp_process` vs `spawn_acp_process_remote` have likely duplication. |

### MODERATE — Acceptable But Watch Growth

| File | Lines | Problem |
|------|------:|---------|
| `src-tauri/src/ssh/session.rs` | 1130 | Largest function 144 lines (`spawn_remote_pty`). Methods are cohesive — all on `RemoteSshSession`. Size driven by protocol complexity, not poor structure. Could extract auth methods to separate module. |
| `src-tauri/src/ipc/worktree_handlers.rs` | 723 | Similar to acp_handlers — many small handlers. Less urgent since it's one domain (worktrees). |
| `src-tauri/src/ipc/execution_handlers.rs` | 698 | Same pattern. |
| `src/components/execution/activity/ComposeBar.tsx` | 663 | Only one 69-line function flagged. Size comes from JSX + state hooks. Typical complex input component — not alarming. |

### LOW — No Refactoring Needed

| File | Lines | Problem |
|------|------:|---------|
| `maestro-protocol/src/lib.rs` | 800 | Zero functions over 50 lines. Pure type definitions (structs, enums). Size is fine — splitting type definitions across files adds navigation cost with no structural benefit. |
| `src/components/ui/sidebar.tsx` | 685 | UI component library file. Multiple small components co-located. Standard pattern. |
| `src-tauri/src/ipc/project_handlers.rs` | 641 | Handler collection. Manageable. |
| `src/components/execution/activity/MarkdownBlock.tsx` | 608 | Rendering logic — inherently complex for markdown. |
| `src/components/project-picker/SshAuthModal.tsx` | 582 | Multi-step modal. Could extract step components but not urgent. |
| `src/components/execution/AgentActivityPanel.tsx` | 558 | Reasonable for a complex panel. |
| `maestro-server/src/main.rs` | 541 | Entry point + routing. Already extracted `session_handler`. Fine. |

## Top 2 Refactoring Targets

1. **`maestro-server/src/session_handler.rs`** — 524-line and 474-line functions are unambiguously too large. Extract sub-steps (config building, process spawning, message loop setup, error recovery) into helper functions.

2. **`src/components/execution/WorktreeDiffPanel.tsx`** — 697-line single component. Extract: `DiffFileList`, `DiffHunkView`, `DiffHeader`, `DiffStats` sub-components.
