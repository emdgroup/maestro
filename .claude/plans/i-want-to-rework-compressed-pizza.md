# Rework Agent Activity Panel — Visual Style Upgrade

## Context

Two changes in scope:
1. **Structural** (DONE): Vertical line now spans through tool calls via AgentResponseSection wrapper
2. **Visual** (THIS PLAN): Upgrade badge, user message, and connector line styling

Chosen combo: **B1 (Solid Gradient badge) + G2 (Subtle Accent gradient border) + Muted Fade line**

## Files to Modify

1. `src/components/execution/activity/AgentResponseSection.tsx` — badge + line style
2. `src/components/execution/activity/ActivityUserMessage.tsx` — user badge + gradient border message
3. `src/components/execution/AgentActivityPanel.tsx` — sticky bar user badge

## Implementation Details

### 1. `AgentResponseSection.tsx` — Agent Badge + Connector Line

**Agent badge** — solid gradient fill with glow shadow:
```tsx
// Before:
<div className="w-7 h-7 rounded-md bg-accent/20 border border-accent/30 flex items-center justify-center flex-shrink-0">
  <Bot className="w-4 h-4 text-accent-foreground/70" />
</div>

// After (B1 — Solid Gradient):
<div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-accent/70 shadow-md shadow-accent/40 flex items-center justify-center flex-shrink-0">
  <Bot className="w-4 h-4 text-white" />
</div>
```

**Connector line** — muted fade (30% accent → transparent):
```tsx
// Before:
{showConnector && <div className="w-px flex-1 bg-border mt-1" />}

// After:
{showConnector && <div className="w-[1.5px] flex-1 bg-gradient-to-b from-accent/30 to-transparent mt-1" />}
```

### 2. `ActivityUserMessage.tsx` — User Badge + Gradient Border Message

**User badge** — subtle gradient with border (matches B1 user variant):
```tsx
// Before:
<div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
  <User className="w-3.5 h-3.5 text-muted-foreground" />
</div>

// After:
<div className="w-7 h-7 rounded-full bg-gradient-to-br from-muted-foreground/20 to-muted/80 border border-muted-foreground/25 flex items-center justify-center flex-shrink-0">
  <User className="w-3.5 h-3.5 text-muted-foreground" />
</div>
```

**Message bubble** — gradient border using wrapper technique (G2 — Subtle Accent):
```tsx
// Before:
<div className="bg-card border border-border rounded-lg px-3.5 py-2.5 text-sm leading-relaxed text-foreground break-words">
  {content}
</div>

// After:
<div className="p-px rounded-[10px] bg-gradient-to-br from-accent/60 to-accent/15">
  <div className="bg-card rounded-[9px] px-3.5 py-2.5 text-sm leading-relaxed text-foreground break-words">
    {content}
  </div>
</div>
```

### 3. `AgentActivityPanel.tsx` — Sticky Bar User Badge

```tsx
// Before:
<div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center flex-shrink-0 border border-border/50">
  <User className="w-2.5 h-2.5 text-muted-foreground" />
</div>

// After:
<div className="w-5 h-5 rounded-full bg-gradient-to-br from-muted-foreground/20 to-muted/80 border border-muted-foreground/25 flex items-center justify-center flex-shrink-0">
  <User className="w-2.5 h-2.5 text-muted-foreground" />
</div>
```

## Visual Summary

| Element | Before | After |
|---------|--------|-------|
| Agent badge | Flat translucent bg + thin border | Solid gradient fill + glow shadow |
| Agent icon color | accent-foreground/70 | white (on gradient bg) |
| Connector line | 1px solid border color | 1.5px accent/30 → transparent fade |
| User badge | Flat bg-muted circle | Gradient from-muted-foreground/20 to-muted/80 + border |
| User message | Flat border-border | Gradient border wrapper (accent/60 → accent/15) |

## Verification

1. `pnpm dev` — visually confirm:
   - Agent badge is solid purple gradient with white Bot icon and subtle glow
   - Connector line fades from light purple to transparent
   - User badge has subtle gradient depth
   - User message has accent-colored gradient border (stronger top-left, fading bottom-right)
2. `pnpm test` — tests pass (no structural changes, purely visual)
3. Check light theme still looks reasonable (gradient opacities should adapt)
