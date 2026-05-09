# Fix: Session resume not displaying conversation history

## Context

After the recent refactoring that consolidated `RemoteProjectServer` into `ProjectServer` and unified local/remote code paths, resuming a previous ACP session opens the panel but shows a loading spinner forever — no conversation history appears.

## Root Cause

**Race condition in `try_session_load_via_project_server`** (`src-tauri/src/ipc/acp_handlers.rs:843-890`).

Current order:
1. `writer_tx.send(bytes).await` — sends `SessionLoadRequest` to shared server
2. Creates `AcpProcess` with `enable_replay_buffer: true`
3. `emit_cached_capabilities(...).await` — extra yield point
4. Inserts session into `app_state.acp.sessions` map

The shared reader task (`handle_shared_server_message` in `manager.rs:900`) receives `SessionUpdate` history-replay messages between steps 1 and 4. It calls `sessions.get(&log_id)` → returns `None` → messages silently dropped. The replay buffer stays empty. Frontend calls `drain_acp_replay`, gets nothing, `isInitializing` stays `true` forever.

This race existed in the old code too but is now triggered more reliably because remote project servers moved from `remote_project_servers` into `project_servers`, causing the fast path (shared server route) to be taken where previously the cold path (dedicated subprocess with per-session reader) was used.

## Secondary Issue

**Rendering regression** in `AgentActivityPanel.tsx`. The new `groupIntoAgentSections` drops thinking blocks and tool calls that appear before the first `agent_message_chunk` in a turn — they become "standalone" items that the renderer filters out. Not the primary bug (user messages would still render if events arrived) but should be fixed for complete history display.

## Fix

### 1. Reorder operations in `try_session_load_via_project_server`

File: `src-tauri/src/ipc/acp_handlers.rs`

Register session in map BEFORE sending the request:

```
1. Construct message bytes (no side effect)
2. Create AcpProcess (enable_replay_buffer: true)
3. emit_cached_capabilities
4. Insert into sessions map
5. THEN send SessionLoadRequest
6. On send failure → remove session from map, return Err
```

### 2. Fix `groupIntoAgentSections` standalone handling

File: `src/components/execution/activity/utils.ts`

In the `else` branch (item is not message, not userMessage, no currentSection), start a new `currentSection = [gi]` instead of pushing as standalone. This keeps thinking blocks and tool calls attached to their turn.

### 3. Update renderer for sections without leading message

File: `src/components/execution/AgentActivityPanel.tsx` (lines 467-470)

Remove the guard `if (firstItem.type !== "solo" || firstItem.item.type !== "message") return null`. Generate `sectionKey` from whatever the first item is (thinking id, toolCallId, etc.).

## Verification

1. `cd src-tauri && cargo build`
2. `pnpm tauri:dev`
3. Open agent session, do some work, close session tab
4. Resume same session — full conversation history should appear
5. Verify new sessions still work (no regression)
