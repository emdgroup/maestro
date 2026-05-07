# Plan: Redesign ActivityPlanPanel

## Context
ActivityPlanPanel = sticky header in chat scroll area showing plan steps during AI agent execution. Current design too minimal. User iterated through proposals, arrived at final design direction.

## Final Design — User's Chosen Direction

Two states: **Collapsed** (default) and **Expanded** (click to toggle).

### Collapsed View (~110px fixed height)
1. **Title row** — "Plan: name of the plan" (11px, muted label + bold name)
2. **Hero element** — current in_progress step with:
   - Spinner animation (accent color, rotating border)
   - Step description (13px, bold)
   - Elapsed time (10px, tabular-nums)
   - Contained in subtle accent-tinted card (rounded, border)
3. **Summary section** (clickable → toggles expanded) — single row containing:
   - Horizontal segmented rail (same proportional segments, color-coded: success/accent-pulse/muted)
   - "N done" (success color) + "N left" (muted)
   - Chevron indicator (rotates on expand)

### Expanded View (summary click → slides in below)
- Vertical rail replaces/augments horizontal — each segment becomes a vertical step:
  - Left column: dot (8px, color-coded) + connecting line (2px)
  - Right column: step description text
  - Active step: bold + elapsed time shown
  - Completed steps: dimmer opacity
  - Last step: no trailing line
- For 16+ steps: panel bounded by max-height, scrolls internally

## Next Step
Write `plan-panel-redesign.html` showing both states, both 7-step and 16-step variants, integrated in activity panel mock.

## Source component
- `src/components/execution/activity/ActivityPlanPanel.tsx`
- `src/components/execution/AgentActivityPanel.tsx` (mounts at sticky top-0 z-10)
