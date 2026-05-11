# Resume: Verify /simplify fixes

## Context

All four /simplify fixes were already applied. Need to verify they compile.

## Fixes applied

1. **PreflightModal.tsx**: Fixed setTimeout leak — stored timer in `useRef`, clear on unmount and retry
2. **SpawnSessionDialog.tsx**: Removed duplicate `visibleAgents.find` — compute `missingDeps` inline in render
3. **maestro-server/src/main.rs**: Removed redundant `which` subprocess — single `--version` call detects both availability and version
4. **manager.rs**: Fixed pending_* race condition — added `is_some()` guard before inserting oneshot sender in all 4 `query_*_via_server` functions

## Verification

1. `cargo check` in `src-tauri/` and `maestro-server/`
2. `pnpm lint` for frontend
3. `pnpm test` for unit tests
