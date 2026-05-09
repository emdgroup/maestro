# Improve ActivityPlanPanel: Layout, Title, and Click Behavior

## Context

ActivityPlanPanel currently renders as a sticky element **inside** the scroll container in AgentActivityPanel. This causes the vertical scrollbar to appear alongside the plan panel. Additionally, the panel lacks a plan title, and the expand/collapse behavior uses small chevron buttons instead of making the full panel clickable.

## Changes

### 1. Move Plan Panel Outside Scroll Container

**File**: `src/components/execution/AgentActivityPanel.tsx` (lines 444-571)

Current structure:
```
<div.flex-col>
  <div.overflow-hidden>
    <div.relative>
      <div.overflow-y-auto>        ← scroll container
        <ActivityPlanPanel />      ← INSIDE scroll (sticky)
        <div.chat-content />
        {bottomBar}
      </div>
    </div>
  </div>
</div>
```

New structure:
```
<div.flex-col>
  {liveState.plan && <ActivityPlanPanel />}   ← OUTSIDE scroll, fixed at top
  <div.overflow-hidden.flex-1>
    <div.relative>
      <div.overflow-y-auto>        ← scroll container
        <div.chat-content />
        {bottomBar}
      </div>
    </div>
  </div>
</div>
```

Move the plan panel rendering from inside the scroll `<div>` (line 454-458) to before the scroll container wrapper. Add `border-b border-border bg-card` directly on the wrapper. Remove the `sticky top-0 z-10` wrapper div.

### 2. Add Plan Title (Optional)

**Files**:
- `src/components/execution/activity/types.ts` — extend `PlanUpdate` and `ActivityState`
- `src/components/execution/activity/useAcpActivity.ts` — capture title from payload
- `src/components/execution/activity/ActivityPlanPanel.tsx` — display title
- `src/components/execution/AgentActivityPanel.tsx` — pass title prop

Changes:
- Add optional `title?: string` to `PlanUpdate` type
- Add `planTitle: string | null` to `ActivityState`
- In reducer `case "plan"`: capture `payload.title ?? null` into state
- Add `title?: string | null` prop to `ActivityPlanPanel`
- Display after "Plan" label: `Plan: {title}` when title exists, just "Plan" otherwise

The ACP protocol serializes `_meta` and any top-level fields as JSON. If the agent sends `{ sessionUpdate: "plan", entries: [...], title: "..." }`, frontend will now capture it. Title remains optional — display gracefully when absent.

### 3. Collapsed State: Remove Chevron, Full Panel Clickable

**File**: `src/components/execution/activity/ActivityPlanPanel.tsx`

Current collapsed view (starting ~line 127):
- Static "Plan" label
- In-progress card (not clickable)
- Button with progress bars + chevron

Change to:
- Wrap entire collapsed state in a single `<button>` that calls `setExpanded(true)`
- Remove the separate inner `<button>` and its `<ChevronDown>` icon
- Keep the progress bar rail, in-progress card, and "Plan" label as visual elements inside the clickable area
- Add `hover:bg-muted/30` or similar to entire panel for affordance

### 4. Expanded State: Remove Chevron, Full Header Clickable

**File**: `src/components/execution/activity/ActivityPlanPanel.tsx`

Current expanded view (starting ~line 62):
- Button with "Plan" text + chevron that collapses

Change to:
- Keep the header row as a `<button>` (already is) but remove `<ChevronDown>` icon
- The button still calls `setExpanded(false)` — just no chevron visual
- Entire header row remains the clickable collapse target

## Files to Modify

1. `src/components/execution/AgentActivityPanel.tsx` — move plan panel outside scroll, pass title prop
2. `src/components/execution/activity/ActivityPlanPanel.tsx` — accept title prop, remove chevrons, make panels fully clickable
3. `src/components/execution/activity/types.ts` — add `title` to PlanUpdate, `planTitle` to ActivityState
4. `src/components/execution/activity/useAcpActivity.ts` — capture title from payload

## Verification

1. `pnpm dev` — start dev server
2. Start an ACP session with plan entries → verify plan panel appears above scroll area
3. Scroll chat content → verify scrollbar only appears in chat area, not beside plan panel
4. Click anywhere on collapsed plan panel → verify it expands
5. Click anywhere on expanded header → verify it collapses
6. Verify no chevron icons in either state
7. `pnpm lint && pnpm test` — no regressions
