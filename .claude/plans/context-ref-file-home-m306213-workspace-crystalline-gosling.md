# Plan: Glass-style send button with hover feedback

## Context

Send button in ComposeBar uses solid `bg-accent` — opaque circle that breaks the glass aesthetic of the surrounding compose bar (which uses `backdrop-blur-[4px]` + `bg-input/60` + inset shadows). The mockup shows it better integrated but lacks hover feedback. Goal: match glass vibe AND add clear hover state.

## Change

**File:** `src/components/execution/activity/ComposeBar.tsx` line 579

Replace send button classes from:
```
w-8 h-8 rounded-full bg-accent text-accent-foreground flex items-center justify-center flex-shrink-0 disabled:opacity-25 disabled:cursor-not-allowed hover:opacity-90 transition-opacity
```

To glass-style with hover feedback:
```
w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0
bg-accent/15 text-accent border border-accent/25
shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1)]
hover:bg-accent/30 hover:border-accent/40 hover:scale-105
active:scale-95
disabled:opacity-20 disabled:cursor-not-allowed disabled:hover:scale-100
transition-all duration-150
```

Design rationale:
- **Default**: Semi-transparent accent bg (`bg-accent/15`) + accent text + subtle accent border — reads as part of glass family
- **Hover**: Brightens (`bg-accent/30`), border strengthens (`border-accent/40`), slight scale — clear visual feedback
- **Active**: Scale down for press feedback
- **Disabled**: Low opacity, no scale on hover

## Verification

1. `pnpm dev` — open compose bar
2. Check send button blends with glass wrapper (no opaque solid circle)
3. Hover: visible brightening + slight grow
4. Click: press animation
5. Disabled state: faded, no hover reaction
6. Both themes (dark/light) look coherent
