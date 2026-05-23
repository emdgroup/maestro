# Integrations UI Polish — Remaining Fixes

## Context

User feedback after Phase 55 UAT. Previous commit handled: animated tab content transitions (framer-motion AnimatePresence), provider SVG icons (simple-icons), provider order, Cable icon, PAT instructions. Remaining issues:

1. Tab bar style/animation doesn't match app header tabs
2. Redundant headers in both ConnectionList and IntegrationsTab
3. Azure DevOps needs real SVG (user provided path)
4. Connect dialog instruction UX: merge heading + toggle into single "Instructions to get token" toggle

## Changes

### 1. Replace shadcn Tabs with app-header-style tab bar in ProjectPicker

**File:** `src/components/project-picker/ProjectPicker.tsx`

Replace `Tabs`/`TabsList`/`TabsTrigger` from `@/ui/tabs` with custom tab bar matching AppHeader (lines 170-201 of `src/components/common/AppHeader.tsx`):

Pattern to replicate:
```tsx
<LayoutGroup id="picker-tab-nav">
  <div className="grid grid-cols-2 rounded-lg bg-muted p-1 gap-1 mb-4">
    {TABS.map((tab) => {
      const isActive = activeTab === tab.id;
      return (
        <button key={tab.id} onClick={...} className="relative flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium outline-none ...">
          {isActive && (
            <motion.span layoutId="picker-active-pill" className="absolute inset-0 rounded-md bg-background shadow-sm" transition={{ type: "spring", stiffness: 400, damping: 35 }} />
          )}
          <motion.span animate={{ color: isActive ? "var(--accent)" : "var(--muted-foreground)" }} transition={{ duration: 0.15 }} className="relative z-10 flex items-center gap-1.5">
            <Icon className="size-3.5" />
            {tab.label}
          </motion.span>
        </button>
      );
    })}
  </div>
</LayoutGroup>
```

Imports: add `motion`, `LayoutGroup` from framer-motion. Remove `Tabs`, `TabsList`, `TabsTrigger` from `@/ui/tabs`.

Keep existing AnimatePresence for tab content transitions (already working).

### 2. Remove redundant header from ConnectionList

**File:** `src/components/project-picker/ConnectionList.tsx` (line 97-100)

Remove header div + `Globe` from lucide import.

### 3. Add Azure DevOps SVG to ProviderIcon

**File:** `src/components/project-picker/IntegrationsTab.tsx`

Add to `PROVIDER_SIMPLE_ICONS` map:
```tsx
azuredevops: { path: "M17,4v9.74l-4,3.28-6.2-2.26V17L3.29,12.41l10.23.8V4.44Zm-3.41.49L7.85,1V3.29L2.58,4.84,1,6.87v4.61l2.26,1V6.57Z", viewBox: "0 0 18 18" },
```

Update icon map type to `Record<string, { path: string; viewBox?: string }>`. ProviderIcon uses `icon.viewBox ?? "0 0 24 24"`.

Remove `Workflow` from lucide import.

### 4. Simplify instruction toggle in IntegrationConnectDialog

**File:** `src/components/project-picker/IntegrationConnectDialog.tsx`

Replace:
```tsx
<div className="rounded-lg border ...">
  <div className="flex items-center gap-2">
    <Key ... />
    <p>How to get a token</p>
  </div>
  <button>Show instructions</button>
  {open && <ol>...</ol>}
</div>
```

With single collapsible toggle:
```tsx
<button onClick={toggle} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
  {open ? <ChevronUp /> : <ChevronDown />}
  Instructions to get token
</button>
{open && (
  <div className="rounded-lg border border-border bg-muted/40 p-3">
    <ol>...</ol>
  </div>
)}
```

Remove `Key` from lucide import. Simpler, flatter UX — one click reveals instructions.

## Verification

- `pnpm exec tsc --noEmit` — zero errors
- `pnpm test` — 148/148 pass
- Visual: picker tabs animate with spring pill (matching app header), no redundant headings, AzDO icon renders, instructions collapse is single toggle
