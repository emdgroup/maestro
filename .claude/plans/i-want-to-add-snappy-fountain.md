# Plan: Fix Inline Activity Card Style (Option G — Permission-Prompt Style)

## Context

Inline activity cards already exist (`ActivityFileCard.tsx`) but currently use Option A style (plain bordered card with chevron). User chose **Option G** (permission-prompt accent style) with A/E's compact layout and a primary "Open" button. Also need to fix the gap issue (Fragment → wrapper div).

---

## What to Change

### 1. Restyle `ActivityFileCard.tsx`

Replace current bordered-card look with permission-prompt style:
- **Border**: `border-accent/30` with `rounded-[10px]`
- **Background**: `bg-gradient-to-br from-accent/10 to-transparent`
- **Shadow**: `shadow-[0_2px_8px_oklch(0%_0_0/0.08)]`
- **Hover**: `hover:border-accent/50 hover:from-accent/15`
- **Icon box**: Keep same 28px rounded box but use `bg-accent/10 border border-accent/30` styling (accent-tinted rather than variant-colored)
- **Layout**: Same as A/E — single row with icon box + text + "Open" button right-aligned
- **Button**: Replace `ChevronRight` with a primary `<Button variant="default" size="sm">Open</Button>` (shadcn primary button)

Target markup:
```tsx
<button type="button" onClick={onClick}
  className={cn(
    "w-full text-left rounded-[10px] overflow-hidden",
    "border border-accent/30 bg-gradient-to-br from-accent/10 to-transparent",
    "shadow-[0_2px_8px_oklch(0%_0_0/0.08)]",
    "hover:border-accent/50 hover:from-accent/15 transition-colors",
  )}
>
  <div className="flex items-center gap-2.5 px-3.5 py-2.5">
    <div className={cn(
      "w-7 h-7 rounded-[7px] flex items-center justify-center shrink-0",
      "bg-accent/10 border border-accent/30"
    )}>
      <Icon className="w-3.5 h-3.5 text-accent" />
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-xs font-medium text-foreground/85">{title}</div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</div>
    </div>
    <span className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-accent text-accent-foreground shrink-0">
      Open
    </span>
  </div>
  {basenames.length > 0 && (
    <div className="flex gap-1 flex-wrap px-3.5 pb-2.5">
      {basenames.map(...)}
    </div>
  )}
</button>
```

The "Open" button is a static `<span>` styled as primary (bg-accent text-accent-foreground) — whole card is the click target so no nested button needed.

### 2. Fix Gap Between Tool Group and Cards

In `AgentActivityPanel.tsx` render loop, the cards currently render inside a React Fragment (`<>...</>`) which doesn't participate in parent `space-y-3`. Replace with `<div className="space-y-3">`.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/components/execution/activity/ActivityFileCard.tsx` | Restyle to accent gradient + primary "Open" button |
| `src/components/execution/AgentActivityPanel.tsx` | Replace `<>...</>` with `<div className="space-y-3">` around tool group + cards |

---

## Verification

1. `pnpm tsc --noEmit` — 0 errors
2. Cards show accent border + gradient matching PermissionPrompt style
3. "Open" button appears right-aligned, primary colored (bg-accent)
4. Gap between tool call group and cards renders correctly (space-y-3)
5. Hover state: border intensifies, gradient deepens slightly
