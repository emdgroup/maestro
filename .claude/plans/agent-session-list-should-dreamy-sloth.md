# Plan: Order session lists by most recent first

## Context

Session lists (both active and history) currently show oldest first or in arbitrary agent-returned order. User wants newest sessions at the top.

## Changes

### 1. Active sessions — Rust sort reversal
**File:** `src-tauri/src/ipc/acp_handlers.rs` (line ~594)

Current: `sessions.sort_by(|a, b| a.started_at.cmp(&b.started_at))` (ascending)
Change to: `sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at))` (descending — newest first)

### 2. Session history list — frontend sort
**File:** `src/components/execution/SessionHistoryPanel.tsx`

Sort `useSessionListQuery` results by `updated_at` descending before rendering. Entries with null `updated_at` go to the bottom.

## Verification

1. Start app, open agent monitor — newest active session appears first
2. Open session history panel — most recently updated session appears at top
