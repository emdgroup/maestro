# Fix: Views rendering out of viewport

## Context

All tabs except "Agents" intermittently render out of the viewport. Only fix is navigating to Agents tab and back (which unmounts/remounts the broken view via AnimatePresence). The root cause is the dual animation architecture in `src/App.tsx`:

- **AgentsView** (reliable): Always mounted, uses imperative `useAnimationControls()` with `.set()` + `.start()`
- **Other views** (buggy): Conditionally rendered inside `<AnimatePresence initial={false}>` with declarative `variants`. The enter→center animation can fail to complete (Framer Motion 12.40 + React StrictMode double-mount interference + AnimatePresence lifecycle timing), leaving a residual CSS `transform: translateX(...)` that the parent's `overflow-hidden` clips.

## Fix: Unify all views to always-mounted + imperative controls

Eliminate `AnimatePresence`. Make kanban, worktrees, settings follow the same pattern as AgentsView.

## Changes

### 1. `src/App.tsx` — Main changes

**Add 3 new animation controllers** alongside existing `agentsControls`:
```tsx
const kanbanControls = useAnimationControls();
const worktreesControls = useAnimationControls();
const settingsControls = useAnimationControls();
```

Create lookup map:
```tsx
const viewControls: Record<ViewType, AnimationControls> = {
  kanban: kanbanControls,
  agents: agentsControls,
  worktrees: worktreesControls,
  settings: settingsControls,
};
```

**Replace existing agents-only useEffect (lines 90-108)** with unified animation coordinator:
```tsx
useEffect(() => {
  const prevTab = prevTabRef.current;
  prevTabRef.current = activeTab;
  if (prevTab === activeTab) return;

  viewControls[prevTab].start({
    x: `${-100 * slideDirection}%`,
    opacity: 0,
    transition: { duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING },
  });

  viewControls[activeTab].set({ x: `${100 * slideDirection}%`, opacity: 0 });
  viewControls[activeTab].start({
    x: 0,
    opacity: 1,
    transition: { duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING },
  });
}, [activeTab, slideDirection]);
```

**Replace AnimatePresence block (lines 190-261)** with 4 always-mounted motion.divs:

Each view gets:
- `initial={activeTab === "<view>" ? { x: 0, opacity: 1 } : { x: "100%", opacity: 0 }}`
- `animate={<view>Controls}`
- `className={cn("absolute inset-0 overflow-hidden", activeTab !== "<view>" && "pointer-events-none")}`
- Active view gets `z-10`, inactive get `z-0` (ensures active is on top during transitions)

SettingsView and WorktreesView wrappers need an inner scroll div since we use `overflow-hidden` on the motion.div (matching AgentsView). KanbanView handles its own column scrolling internally.

```tsx
{/* Settings wrapper needs inner scroll */}
<motion.div ... className={cn("absolute inset-0 overflow-hidden", ...)}>
  <div className="h-full overflow-auto custom-scrollbar">
    <Suspense fallback={fallback}>
      <SettingsView ... />
    </Suspense>
  </div>
</motion.div>
```

**Update imports**: Remove `AnimatePresence` from framer-motion import. Remove `slideVariants` import (still used by ProjectPicker, just not here).

### 2. `src/components/views/BoardView.tsx` — Secondary fix

Add `min-h-0 overflow-hidden` to grid container (line 34) to prevent grid from exceeding its flex allocation:
```diff
-<div className="grid grid-cols-5 p-4 bg-background flex-1">
+<div className="grid grid-cols-5 p-4 bg-background flex-1 min-h-0 overflow-hidden">
```

## Files modified
- `src/App.tsx` — Remove AnimatePresence, add 3 controllers, unify animation effect, 4 always-mounted views
- `src/components/views/BoardView.tsx` — Add `min-h-0 overflow-hidden` to grid

## No changes needed
- `src/utils/constants/animations.ts` — `slideVariants` still used by ProjectPicker
- `src/store/navigationStore.ts` — Logic unchanged
- View components — No internal changes needed

## Tradeoffs
- All 4 views always mounted = slightly more DOM nodes. Acceptable for desktop app. Upside: preserves filter/scroll state across tab switches.
- All lazy chunks load in parallel on startup instead of on-demand. Negligible for Tauri (local bundles, no network).

## Verification
1. `pnpm build` — TypeScript compilation passes
2. `pnpm tauri:dev` — Launch app, verify:
   - All 4 tabs render correctly on initial load
   - Rapid tab switching doesn't cause viewport issues
   - Slide animations work in both directions
   - Scroll works in Settings and Worktrees views
   - Kanban columns scroll independently
   - Going to Agents and back still works (now same pattern as all views)
3. `pnpm test` — Existing tests pass
