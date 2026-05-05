# Context Indicator Popover Redesign

## Context

Current popover is minimal — shows "Context: XX%" text and an optional Compact button (only when `onCompact` is provided and not processing). User wants:
1. Much prettier glass-style design (matching ComposeBar)
2. Contextual tips/advice depending on state (normal/amber/warning/critical)
3. Compact button always displayed (not conditional on `onCompact` prop presence)

## Implementation Plan

### File to modify
`src/components/execution/activity/LiquidContextIndicator.tsx` (lines 232-241 — PopoverContent)

### Changes

1. **Replace PopoverContent internals** (lines 232-241) with new layout:
   - Header row: "Context Window" label with state-colored dot + large `pct%`
   - Progress bar: 4px track with state-colored fill
   - Token info row: `{humanized used} / {humanized size} tokens` left, cost right (if available)
   - Contextual tip: state-colored panel with icon + message
   - Separator
   - Compact button: always rendered, urgent style at critical

2. **Add tip messages** as a `Record<FillState, { icon: string; text: string }>`:
   - normal: "✓" / "Plenty of room. Agent has full context for complex reasoning."
   - amber: "→" / "Filling up. Consider compacting if task will run longer."
   - warning: "⚠" / "Running low. Agent may lose early context soon. Compact recommended."
   - critical: "⚡" / "Near limit. Agent will auto-compact soon. Compact now to stay in control."

3. **Glass styling on PopoverContent**: 
   - `backdrop-blur-[4px] bg-popover/60 border-border/30`
   - `shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)]`
   - Width: `w-64` (260px)

4. **Compact button always visible**: Remove `{onCompact && ...}` conditional. Button calls `onCompact?.()` with optional chaining (no-op if undefined). At critical state: red urgent styling.

5. **Import `humanizeTokenCount`** from `@/lib/format-utils`

### Props change
- `onCompact` stays optional — button always renders, calls `onCompact?.()` on click

### No changes needed to
- Spring animation logic (unchanged)
- SVG orb rendering (unchanged)  
- ComposeBar (already passes onCompact correctly)
- CSS keyframes (ctx-pulse stays)

## Verification
1. `pnpm dev` — open agent activity panel
2. Hover context orb — verify glass popover appears with all elements
3. Check all 4 states visually (can mock usage values)
4. Click compact button — verify `/compact` sends
5. `pnpm lint` + `pnpm test` pass
