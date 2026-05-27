# CreateTaskModal Round 3 — Polish Fixes

## Context

Round 2 changes introduced visual regressions. User tested and found 4 issues:
1. Issue popover combobox: `data-selected:bg-accent` too prominent — options look highlighted constantly
2. Branch popover tabs: wrong style — should match app header tabs (pill-in-muted-container style)
3. Priority options: too much vertical space between items
4. Agent options: icons wrong, model submenu looks generated → **postpone agent rework entirely**

## Changes

### 1. Fix CommandItem hover state (`src/components/ui/command.tsx`)

**Problem:** Previous fix changed `bg-muted` → `bg-accent`. Accent is too strong — user wants subtle hover.

**Fix:** Use a lighter, transparent hover instead:
```
data-selected:bg-foreground/5 data-selected:text-foreground
```
Remove `data-selected:**:[svg]:text-accent-foreground` (no special SVG recolor needed).

This gives subtle highlight without being the "selected/active" accent color.

### 2. Branch popover tabs → match app header style (`src/components/kanban/CreateTaskModal.tsx`)

**Current (wrong):**
```tsx
<TabsList className="w-full rounded-none h-8 bg-transparent border-b border-border">
  <TabsTrigger value="local" className="flex-1 text-xs h-full rounded-none">
```
This gives underline-style tabs. User wants pill-in-muted-container like AppHeader.

**App header pattern:**
```tsx
<div className="grid grid-cols-4 rounded-lg bg-muted p-1 gap-1">
  <button className="relative ... rounded-md px-3 py-1.5 text-xs font-medium ...">
```

**Fix:** Replace `Tabs`/`TabsList`/`TabsTrigger` with same pattern as header:
- Container: `flex rounded-md bg-muted p-0.5 gap-0.5 w-full`
- Each tab button: `flex-1 rounded-[5px] px-2 py-1 text-xs font-medium text-muted-foreground transition-colors`
- Active: `bg-background text-foreground shadow-sm`
- Inactive: `hover:text-foreground/80`

Use local `branchTab` state (`"local" | "remote"`) — no need for base-ui Tabs overhead inside a small popover.

### 3. Priority options spacing (`src/components/kanban/CreateTaskModal.tsx`)

**Current:** Each priority button has `py-1` + container has implicit gaps. `w-36 p-1` popover.

**Fix:** Tighten padding:
- Button: `py-0.5` instead of `py-1`
- Keep `px-2`, `gap-2`, `text-xs`
- Container stays `w-36 p-1`

### 4. Agent pill — revert to simple select (postpone rework)

**Current:** Complex split-button with ChevronRight expand + inline model submenu.

**Fix:** Revert agent popover to simple list like priority:
- Each agent: icon (use agent's actual icon from `DiscoveredAgent.icon` field if available, else `Bot`) + name + check
- Same compact style as priority options (`py-0.5 px-2 gap-2 text-xs`)
- Remove model submenu, `expandedAgentId` state, `shortModelName` helper, `AVAILABLE_MODELS` import
- Remove `modelOverride` from form data and `createTask` call (revert to `null`)
- Keep `model_override` in backend/bindings (already shipped) — just don't use it from this modal yet

## Files

| File | Action |
|------|--------|
| `src/components/ui/command.tsx` | Change `data-selected` to `bg-foreground/5` |
| `src/components/kanban/CreateTaskModal.tsx` | Fix branch tabs, priority spacing, simplify agent |

## Verification

1. `pnpm build` — compiles clean
2. `pnpm tauri:dev` — visual check:
   - Issue combobox hover: subtle, not accent-colored
   - Branch popover tabs: pill style matching header
   - Priority dropdown: compact, no wasted space
   - Agent dropdown: simple list, no model submenu
