# Plan: Commit Pending Changes

## Context

Large set of uncommitted work (~51 files, net -1200 lines). Changes span protocol handshake, RPC extraction, websocket→streaming migration, store cleanup, and frontend hook extraction. This is coherent work that should be committed as a single logical unit.

## Summary of Changes

1. **Protocol handshake** — `maestro-protocol` gains `HandshakeRequest`/`HandshakeResponse`, version constant
2. **RPC helpers** — new `src-tauri/src/acp/rpc.rs` extracts one-shot RPC logic from handlers (DRY)
3. **Handshake in spawn** — `manager.rs` performs handshake before spawn, both local and remote
4. **WebSocket → Streaming** — deleted `websocket/` module, added `streaming/` module
5. **Error type** — new `src-tauri/src/error.rs` with `MaestroError` (thiserror)
6. **ACP session identity** — `acp_session_id` field on `AcpProcess`, exposed in `ActiveSessionInfo`
7. **Session list aliasing** — `list_acp_sessions` now accepts `project_id`, handles alias persistence/pruning
8. **Store cleanup** — removed dead task execution methods from `boardStore`, KanbanBoard/BoardView use query data directly
9. **Frontend hook extraction** — `useAcpSessionLifecycle`, `useAcpScrollBehavior`, `useStagingState`, `useExecuteTask`
10. **Misc** — ThemeProvider, FilePicker, AppHeader, vite config, dependency updates

## Actions

1. Stage all tracked changes (modified + deleted files)
2. Stage new untracked files that are part of the feature (rpc.rs, error.rs, streaming/, hooks)
3. Exclude `.claude/` dirs, `.maestro/`, `.planning/frontend-audit.md`, `acp-session-mockup.html` from commit
4. Commit with descriptive message following repo conventions

## Commit Message

```
Add protocol handshake, extract RPC helpers, and clean up stores

- Add version handshake between maestro and maestro-server on connection
- Extract one-shot RPC logic into acp/rpc.rs module
- Replace websocket module with streaming module
- Add MaestroError type with thiserror
- Expose acp_session_id for session alias management
- Remove dead task execution methods from boardStore
- Extract useAcpSessionLifecycle, useAcpScrollBehavior hooks
- Use TanStack Query data directly in KanbanBoard/BoardView

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## Verification

- `cargo check` in src-tauri passes
- `pnpm lint` passes
- `pnpm test` passes
