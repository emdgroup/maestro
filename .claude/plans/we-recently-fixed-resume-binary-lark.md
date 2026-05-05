# Fix: User prompts missing from resumed sessions

## Context

When resuming a session, only agent responses appear — user prompts are absent. This is a bug caused by a naming mismatch between ACP protocol events and our custom live-session events.

**Root cause:** Two different event shapes exist for "user message":

1. **Live session** — maestro-server synthesizes `{"sessionUpdate": "user_message", "content": "...", "sentAt": ...}` when it receives a `PromptRequest` (line 210-221 of `main.rs`)
2. **Resumed session** — the ACP agent replays history via `SessionNotification` containing the native `SessionUpdate::UserMessageChunk` variant, which serializes as `{"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "..."}, ...}`

The frontend reducer only handles `"user_message"` — `"user_message_chunk"` falls through to `default` and is silently dropped.

## Fix

Add `user_message_chunk` handling to the frontend activity reducer. Same approach as `agent_message_chunk` (which already works correctly for replayed agent messages).

### Files to modify

1. **`src/components/execution/activity/types.ts`** — Add `UserMessageChunkPayload` type to `SessionUpdatePayload` union
2. **`src/components/execution/activity/useAcpActivity.ts`** — Add `case "user_message_chunk"` to reducer

### Implementation

**types.ts** — Add after `UserMessagePayload`:
```typescript
export type UserMessageChunkPayload = {
  sessionUpdate: "user_message_chunk";
  content: { type: "text"; text: string };
};
```

Add to `SessionUpdatePayload` union.

**useAcpActivity.ts** — Add case before `default`:
```typescript
case "user_message_chunk": {
  const items = finalizeLastStreaming(newState.items);
  const lastItem = items[items.length - 1];
  if (lastItem && lastItem.type === "userMessage") {
    // Accumulate chunks into same user message
    const updated = { ...lastItem.item, content: lastItem.item.content + payload.content.text };
    return { ...newState, items: [...items.slice(0, -1), { type: "userMessage", item: updated }] };
  }
  const userMsg: UserMessageItem = {
    id: `user-${crypto.randomUUID()}`,
    content: payload.content.text,
    sentAt: Date.now(),
  };
  return { ...newState, items: [...items, { type: "userMessage", item: userMsg }] };
}
```

Note: Chunks are streamed (each `UserMessageChunk` carries one `ContentBlock`). Multiple chunks for the same user message need accumulation — same pattern as `agent_message_chunk` accumulates into a single `MessageItem`.

## Verification

1. Start a session, send a few prompts, let agent respond
2. Close the session
3. Resume it from SessionHistoryPanel
4. Confirm both user prompts AND agent responses appear in the activity panel
5. Run `pnpm test` to ensure no regressions
