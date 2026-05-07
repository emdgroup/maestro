# Remove PopoverArrow from Context Indicator

## Context
The popover arrow on the context indicator adds visual noise without improving clarity. The popover already opens adjacent to the 16px trigger with `sideOffset={8}` — spatial relationship is obvious. Arrow also breaks the frosted-glass aesthetic (flat solid triangle vs blur).

## Changes

**File:** `src/components/execution/activity/LiquidContextIndicator.tsx`

1. Remove `PopoverArrow` from the import on line 4
2. Remove the `<PopoverArrow ... />` element (lines 344-347)

## Cleanup

- Delete `preview-context-indicator.html` (temporary preview file)

## Verification

- `pnpm lint` passes
- `pnpm dev` — open an active session, hover the context indicator, confirm popover still renders correctly without arrow
