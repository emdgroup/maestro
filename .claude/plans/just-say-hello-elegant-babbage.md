# Fix: Plan permission overlay shows empty + empty plan should auto-approve

## Context

Two issues with the `switch_mode` (ExitPlanMode / "Ready to code?") permission request:

1. **Empty plan** — agent exits plan mode without writing anything → full-screen overlay shows with only buttons, no content. Should not show at all (auto-approve).
2. **Non-empty plan shows empty** — agent writes plan then exits → overlay shows but plan text is missing. Was working before recent changes.

## Analysis

Parsed code thoroughly. The `extractBodyText` logic in `PermissionPrompt.tsx` is unchanged and correctly handles the expected ACP JSON format:
```
payload.toolCall.content[] → items where type="content" → inner.content where type="text" → text field
```

The `isPlanPermission` check works (overlay appears), meaning `payload.toolCall.kind === "switch_mode"` matches. But `extractBodyText` returns null.

**Root cause for issue #2 unknown from static analysis** — need runtime payload inspection. Possible causes:
- Claude Code agent version changed how it structures `switch_mode` content
- Content might now be in `rawInput` instead of `content` array
- Content might use `resource` type instead of `text` type (not handled by `extractBodyText`)

## Plan

### Step 1: Add diagnostic + broader text extraction

**File: `src/components/execution/activity/PermissionPrompt.tsx`**

1. Export `extractBodyText`
2. Extend `extractBodyText` to also handle:
   - `ContentBlock::Resource` format: `{type: "content", content: {type: "resource", resource: {text: "..."}}}`
   - `rawInput` field: check if `toolCall.rawInput` contains displayable text
3. Add a `console.warn` when `isPlanPermission` is true but `extractBodyText` returns null, logging the full `toolCall` object for debugging

### Step 2: Handle empty plan — auto-approve

**File: `src/components/execution/AgentActivityPanel.tsx`**

Add `useEffect` that auto-approves when:
- `pendingPermission` is a plan permission (`isPlanPermission`)
- `extractBodyText` returns null (no displayable content)

```typescript
useEffect(() => {
  if (!pendingPermission || !isPlanPermission(pendingPermission.payload)) return;
  if (extractBodyText(pendingPermission.payload) !== null) return;
  // No plan content — auto-approve with first allow option
  const options = pendingPermission.payload.options as Array<{ optionId: string; kind: string }> | undefined;
  const allowOpt = options?.find(o => o.kind === "allow_once" || o.kind === "allow_always");
  if (allowOpt) {
    handlePermissionRespond(pendingPermission.requestId, allowOpt.optionId);
  }
}, [pendingPermission, handlePermissionRespond]);
```

And in the render section, skip the overlay when body text is null:
```typescript
if (isPlanPermission(pendingPermission.payload)) {
  const hasBody = extractBodyText(pendingPermission.payload) !== null;
  if (hasBody) {
    planOverlay = ( ... fullHeight PermissionPrompt ... );
  }
  // else: useEffect will auto-approve, nothing to render
}
```

### Step 3: Import changes

In `AgentActivityPanel.tsx`, import `extractBodyText` from `./activity/PermissionPrompt`.

## Files to modify

1. `src/components/execution/activity/PermissionPrompt.tsx` — export `extractBodyText`, extend resource handling, add diagnostic log
2. `src/components/execution/AgentActivityPanel.tsx` — import `extractBodyText`, add auto-approve effect, gate overlay on body text

## Verification

1. Run app, trigger agent with empty plan exit → confirm auto-approve (no panel)
2. Run app, trigger agent with real plan → check console for diagnostic output on payload structure
3. If plan text shows: done. If still empty: use console output to identify correct field path and fix `extractBodyText`
