---
status: complete
phase: 44-db-schema-acp-ipc-handlers
source: 44-01-SUMMARY.md, 44-02-SUMMARY.md
started: 2026-04-21T00:30:00Z
updated: 2026-04-21T00:45:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running dev server. Start the app fresh (pnpm tauri:dev or pnpm build). App boots without errors. No DB migration errors in console. The main UI loads and existing tasks/projects are visible. No crash on startup.
result: pass

### 2. TypeScript bindings include ACP commands
expected: Open src/types/bindings.ts. Verify it contains spawnAcpSession, sendAcpPrompt, respondAcpPermission, cancelAcpSession — and does NOT contain the old stale names startAcpSession or sendToAcpSession.
result: pass

### 3. ExecutionWithTask has new fields
expected: In src/types/bindings.ts, the ExecutionWithTask type has two new fields: execution_mode: string | null and agent_id: string | null.
result: pass

### 4. Execution list backward compatibility
expected: In the running app, open the Agents or Worktrees view and confirm existing PTY-based execution sessions still appear in the list without errors. New execution_mode/agent_id columns show null for old sessions — they don't break the list UI.
result: pass

### 5. Frontend build succeeds with new bindings
expected: Running pnpm build completes without TypeScript errors. The only acceptable output is pre-existing chunk-size warnings (unrelated). No type errors referencing spawnAcpSession, ExecutionWithTask, execution_mode, or agent_id.
result: pass

## Summary

total: 5
passed: 5
issues: 0
pending: 0
skipped: 0

## Gaps

[none yet]
