# Fix Agent Session Regression from Activity Sectioning Refactor

## Context

Uncommitted refactor changed the activity rendering from a flat list to a sectioned layout (grouping agent responses under `AgentResponseSection` with bot avatar + connector). This broke 3 features:

1. **Live messages not displaying** — items before first `message` chunk are invisible
2. **Shift+Tab mode cycling broken** — likely cascading from #1 (ComposeBar not rendered because `isProcessing` never set correctly)
3. **Can't interrupt agent** — same cascade: if UI doesn't reflect processing state, cancel path not triggered

## Root Cause Analysis

**Primary bug** is in `groupIntoAgentSections()` (`src/components/execution/activity/utils.ts` lines 36-40):

```typescript
} else {
  if (currentSection) {
    currentSection.push(gi);
  } else {
    sections.push({ type: "standalone", item: gi });
  }
}
```

Items arriving before the first `message` event (thinking blocks, tool calls) become `standalone` items. Then in `AgentActivityPanel.tsx` line 461-463, standalone items are filtered:

```typescript
if (gi.type !== "solo" || gi.item.type !== "userMessage") return null;
```

**Result**: Any thinking/toolCall/permissionResponse before first `agent_message_chunk` → invisible. Agent can start with thinking or tool calls before producing text — this is common.

**Bug #2 and #3 are likely NOT cascading from #1** — the keyboard handling is in `ComposeBar.tsx` (unchanged), `isProcessing` is set by `handleSend` and cleared by `turn-ended` event listener (line 82-87). These are independent of rendering. Need to verify if the ComposeBar is actually being rendered (it's in the `bottomBar` variable, which is only set when `!isSessionDead && !elicitationContent && !pendingPermission`).

**Re-examining**: ComposeBar receives `modes` and `modeId` from `useAcpSessionLifecycle`. If that hook fails to populate modes (e.g., because session events aren't flowing), `modes` would be empty → shift+tab does nothing (it checks `modes.length > 0`). The interrupt (Escape) checks `isProcessing` — if messages ARE flowing (reducer processes events) but just not RENDERING, `isProcessing` should still be true. But if the session never registers as processing (e.g., `set_initialized` fires but no events flow), then ComposeBar gets `isProcessing=false` and Escape does nothing.

**Most likely**: All three bugs trace to events not flowing at all, which would be a Rust-side issue from the transport refactor. OR: events flow, items accumulate, but rendering drops them.

## Fix Plan

### Fix 1: `groupIntoAgentSections` — handle pre-message items

**File**: `src/components/execution/activity/utils.ts`

Change: When items arrive before any `message` item and no `currentSection` exists, start a new section (without a leading message). The rendering code must then handle sections that don't start with a message.

```typescript
} else {
  if (currentSection) {
    currentSection.push(gi);
  } else {
    // Start a new section even without a leading message
    currentSection = [gi];
  }
}
```

### Fix 2: `AgentActivityPanel` — render sections without leading message

**File**: `src/components/execution/AgentActivityPanel.tsx`

Change the guard at line 468-470:
```typescript
const firstItem = items[0];
if (firstItem.type !== "solo" || firstItem.item.type !== "message") return null;
const sectionKey = firstItem.item.item.id;
```

Instead, derive `sectionKey` from whatever the first item is (message, thinking, toolGroup):
```typescript
const firstItem = items[0];
let sectionKey: string;
if (firstItem.type === "solo" && firstItem.item.type === "message") {
  sectionKey = firstItem.item.item.id;
} else if (firstItem.type === "solo" && firstItem.item.type === "thinking") {
  sectionKey = firstItem.item.item.id;
} else if (firstItem.type === "toolGroup") {
  sectionKey = `tg-${firstItem.items[0].toolCallId}`;
} else if (firstItem.type === "solo") {
  sectionKey = `section-${firstItem.item.type}-${(firstItem.item.item as { id: string }).id}`;
} else {
  sectionKey = `section-fallback`;
}
```

### Fix 3: Verify Shift+Tab and Interrupt

After fixes 1+2, verify:
- `modes` array is populated (check `useAcpSessionLifecycle` hook)
- `isProcessing` transitions correctly on send/turn-end
- ComposeBar renders when session is alive and no permission/elicitation pending
- Escape key handler fires `handleCancel`

If modes/models don't populate, investigate the Rust-side `emit_cached_capabilities()` and the `AcpReadSource` unification in `spawn_reader_task`.

### Fix 4: Standalone rendering fallback

In `AgentActivityPanel.tsx` line 461-463, also render non-userMessage standalone items (though with fix 1, these should be rare — only possible if a non-message/non-userMessage item arrives between two userMessages):

```typescript
if (section.type === "standalone") {
  const gi = section.item;
  if (gi.type === "solo" && gi.item.type === "userMessage") {
    return <ActivityUserMessage key={gi.item.item.id} message={gi.item.item} />;
  }
  // Wrap orphan items in AgentResponseSection
  if (gi.type === "toolGroup") {
    // render tool group in section wrapper
  }
  // etc.
  return null; // fallback for truly unexpected items
}
```

## Files to Modify

1. `src/components/execution/activity/utils.ts` — fix `groupIntoAgentSections`
2. `src/components/execution/AgentActivityPanel.tsx` — fix section rendering guard

## Verification

1. `pnpm dev` — start frontend
2. `pnpm tauri:dev` — start full app
3. Start an agent session, verify:
   - Thinking blocks visible immediately (before first text)
   - Tool calls visible
   - Agent text messages appear and stream
   - Shift+Tab cycles permission modes
   - Escape interrupts agent turn
   - Permission prompts render and are dismissible
4. `pnpm test` — run existing tests
5. `pnpm lint` — check for lint errors
