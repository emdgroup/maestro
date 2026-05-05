# Plan: Order session lists by most recent first (frontend-only)

## Context

Session lists show oldest first (active sessions sorted ascending by `started_at` in Rust) or in arbitrary agent-returned order (history). User wants newest first, both done on frontend.

## Changes

### 1. Active sessions — sort in AgentMonitor.tsx
**File:** `src/components/execution/AgentMonitor.tsx`

After filtering (line ~100), sort `filteredSessions` by `started_at` descending before grouping. The `ActiveSessionInfo` has `started_at: string` (ISO timestamp). Compare with simple string compare (ISO sorts lexicographically).

Remove backend sort in `src-tauri/src/ipc/acp_handlers.rs` line 594 (now redundant/misleading).

### 2. Session history — sort in SessionHistoryPanel.tsx
**File:** `src/components/execution/SessionHistoryPanel.tsx`

Sort `sessions` array by `updated_at` descending before rendering (line ~109). Entries with null `updated_at` go to bottom.

## Verification

1. `pnpm dev` — open agent monitor, newest active session appears first in each branch group
2. Open session history panel — most recently updated session at top
