# Plan: Enter key submits SpawnSessionDialog

## Context

When user opens "New Session" dialog, all mandatory fields (agent type + worktree) are pre-filled with defaults. User expects Enter to submit immediately — but currently only the "Start Session" button click works. No `<form>` or keyboard handling exists.

## Change

**File**: `src/components/execution/SpawnSessionDialog.tsx`

Wrap dialog body + footer in a `<form>` element with `onSubmit` that calls `handleSpawn`. This gives native Enter-to-submit behavior without manual `onKeyDown` wiring.

### Implementation

1. Wrap the `<div className="space-y-5 py-1">` and `<DialogFooter>` in a `<form onSubmit={...}>` element
2. `onSubmit` handler: `preventDefault()` + call `handleSpawn()` (if not disabled)
3. Change "Start Session" `<Button>` to `type="submit"` (remove `onClick`)
4. Keep "Cancel" button as `type="button"` (prevents Enter triggering cancel)

### Code sketch

```tsx
<DialogContent className="sm:max-w-md">
  <DialogHeader>...</DialogHeader>
  <form onSubmit={(e) => { e.preventDefault(); if (selectedWorktree && !isPending) handleSpawn(); }}>
    <div className="space-y-5 py-1">
      {/* existing fields unchanged */}
    </div>
    <DialogFooter>
      <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
        Cancel
      </Button>
      <Button type="submit" disabled={!selectedWorktree || isPending}>
        {isPending ? "Starting..." : "Start Session"}
      </Button>
    </DialogFooter>
  </form>
</DialogContent>
```

## Why `<form>` over `onKeyDown`

- Native browser behavior — Enter on any focusable element inside form triggers submit
- No need to filter out Enter presses on Select dropdowns (browser handles it)
- Simpler, more accessible, consistent with HTML semantics

## Verification

1. `pnpm dev` → open app → open New Session dialog
2. Without clicking anything, press Enter → session should spawn
3. Verify Enter while Select dropdown is open does NOT spawn (selects item instead)
4. Verify Cancel button still works
5. Verify clicking "Start Session" still works
6. `pnpm lint` passes
