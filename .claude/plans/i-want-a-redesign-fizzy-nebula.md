# Context Indicator Popover — Follow-up Fixes

## Context

Popover redesign (glass style, tips, always-visible compact button, hover-after-1s) is implemented. User reported 4 issues:

1. Shows "—" when no usage data yet — should show "0%" instead
2. Popover closes when mouse moves onto popover content — should stay open
3. Popover overflows into session list — should stay within activity panel
4. Missing visual pointer/arrow connecting popover to the indicator

## Files to modify

- `src/components/execution/activity/LiquidContextIndicator.tsx` — fixes 1, 2, 4
- `src/components/ui/popover.tsx` — fix 3 (expose `collisionBoundary` prop)

## Changes

### Fix 1: Show 0% instead of dash

Line 329 currently: `{usage.size > 1 ? `${pct}%` : "—"}`

Change to always show `${pct}%`. The `pct` variable already computes 0 when `usage.size` is 0 (line 99 clamps ratio to 0). Remove the conditional entirely — just render `{pct}%`.

Also remove the `{usage.size > 1 && ...}` guards on the progress bar (line 334) and token info row (line 344) — show them always with 0 values when no data.

### Fix 2: Popover stays open on content hover

Problem: `handleMouseLeave` fires when cursor moves from trigger to popover content (they're separate DOM elements due to Portal rendering).

Solution: Add `onMouseEnter`/`onMouseLeave` to PopoverContent as well. When mouse enters the popover content, cancel any pending close. When mouse leaves the popover content (and not entering the trigger), close if hover-opened.

```typescript
function handlePopoverMouseEnter() {
  // Cursor moved onto popover — keep it open
  if (hoverTimerRef.current) {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }
}

function handlePopoverMouseLeave() {
  // Cursor left popover content — close if hover-opened
  if (openedByHoverRef.current) {
    openedByHoverRef.current = false;
    setOpen(false);
  }
}
```

Add to PopoverContent: `onMouseEnter={handlePopoverMouseEnter} onMouseLeave={handlePopoverMouseLeave}`

Also update `handleMouseLeave` on trigger: instead of immediately closing, add a small delay (~150ms) so there's time for the cursor to reach the popover content:

```typescript
function handleMouseLeave() {
  if (hoverTimerRef.current) {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }
  if (openedByHoverRef.current) {
    // Small delay to allow cursor to reach popover content
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      openedByHoverRef.current = false;
      setOpen(false);
    }, 150);
  }
}
```

### Fix 3: Constrain popover to activity panel

Two approaches — simplest: use `side="top"` with `collisionPadding` so it doesn't overflow. The popover already uses `side="top"` which positions above the trigger.

Since the popover is portalled (renders at body level), true boundary containment requires passing a `collisionBoundary` element ref. However, the simpler fix is to just add `collisionPadding={16}` which keeps it 16px from viewport edges — since the activity panel is typically the right portion of the screen, this may be sufficient.

**Approach**: Expose `collisionPadding` on `PopoverContent` wrapper, then pass `collisionPadding={16}` from LiquidContextIndicator.

In `src/components/ui/popover.tsx`:
- Add `"collisionPadding"` to the `Pick<>` type on line 22
- Destructure and pass to Positioner

### Fix 4: Add arrow pointing to indicator

Base UI exports `Popover.Arrow` — renders a positioned triangle.

In `src/components/ui/popover.tsx`:
- Export a `PopoverArrow` component wrapping `PopoverPrimitive.Arrow`
- Style: small triangle matching popover background

In `LiquidContextIndicator.tsx`:
- Import `PopoverArrow`  
- Add `<PopoverArrow className="fill-popover/60 [filter:drop-shadow(0_-1px_0_rgba(255,255,255,0.12))]" />` inside PopoverContent (first child, before header)

Base UI Arrow renders inside the Popup and auto-positions itself relative to the anchor. It needs to be placed as a child of PopoverContent (the Popup wrapper).

## Verification

1. `pnpm dev` — open activity panel with a running session
2. Verify "0%" shown when no usage data (not "—")
3. Hover orb → popover appears after 1s → move cursor onto popover → stays open
4. Move cursor away from popover → closes
5. Click orb → popover opens → hover popover → stays → click elsewhere → closes
6. Visually confirm arrow triangle pointing down toward indicator
7. Verify popover doesn't overflow left/right panel boundaries
8. `pnpm lint` passes
