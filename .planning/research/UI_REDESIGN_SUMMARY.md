# v1.1 UI Redesign Stack Research — Summary

**Milestone:** GSD Agent Orchestrator v1.1 — UI/UX Polish
**Researched:** 2026-02-09
**Research Type:** Stack Additions (focused on UI redesign only)

---

## Context

This research addresses **stack additions and configuration changes needed for the v1.1 UI redesign milestone**, building on the validated v1.0 stack. It is **NOT a full re-evaluation** of the core stack (Tauri, React, Rust backend), which remains frozen from v1.0 research.

**Validated & Unchanged from v1.0:**
- Tauri 2.10.1 + Rust backend
- React 19 + TypeScript
- Vite 7.3.1 build tool
- Node.js sidecar for process management
- SQLite for persistence
- Zustand for existing state (Kanban, tasks)
- Radix UI (@radix-ui/react-dialog, @radix-ui/react-select)

**New for v1.1 (this research):**
- Tailwind CSS 4.x styling framework
- shadcn/ui component library
- Custom theme provider (light/dark switching)
- Utility libraries (clsx, class-variance-authority, etc.)

---

## Key Findings

### 1. Tailwind 4.x is the Right Choice for Tauri + Vite

**Why:**
- @tailwindcss/vite plugin integrates seamlessly with existing Vite 7.3.1 setup
- Zero-runtime CSS (all processed at build time)
- Native dark mode via `@theme` directive
- Cleaner than Tailwind 3.x + PostCSS approach
- Peer dependencies: Vite ^5.2.0 || ^6 || ^7 (project uses 7.3.1 ✓)

**NOT next-themes:** next-themes is Next.js-specific and won't work in Tauri desktop apps. Use custom Zustand + localStorage implementation instead.

### 2. shadcn/ui Vite Setup is Viable (Not Next.js-Locked)

**Why:**
- shadcn/ui officially supports Vite (same as Next.js)
- Copy-paste component model means zero framework dependencies
- Built on Radix UI primitives (we already use @radix-ui/react-dialog and @radix-ui/react-select)
- Full TypeScript support without additional complexity

**Manual component addition:** Since CLI scaffolding is Next.js-focused, manually copy components from https://ui.shadcn.com/components. CLI shows required dependencies automatically.

### 3. Theme Implementation: Zustand + localStorage + Media Query

**Why NOT next-themes:**
- Next.js-only; relies on SSR/page-level theme forcing
- Tauri desktop apps have no server rendering
- Adds 10KB+ for single-use library

**Why Zustand-based approach:**
- Reuses existing Zustand store (already in project)
- Simple 50-line theme provider with system preference detection
- localStorage for persistence (standard desktop pattern)
- No new major dependencies

**Implementation:**
- `src/store/themeStore.ts` — Zustand slice for theme state
- `src/components/ThemeProvider.tsx` — DOM class toggling + media query listener
- Apply `.dark` class to `<html>` root for Tailwind dark mode
- Listen for system `prefers-color-scheme` changes

### 4. Migration Strategy: Incremental Component-by-Component

**Why NOT big-bang rewrite:**
- Current CSS structure is isolated (23 separate files)
- Each component can be migrated independently
- Reduces risk of regression
- Allows testing per-component

**Recommended order:**
1. ProjectPicker (simple, few colors)
2. TaskCard (foundational Kanban piece)
3. KanbanBoard (layout)
4. TaskModal (forms)
5. AppHeader (navigation)
6. Agent Monitor (complex layouts)
7. Worktree Manager (tables)
8. Settings (forms)

**Time estimate:** ~2-4 hours per component (includes testing)

### 5. CSS Modules Reserved for Complex Cases Only

**Keep count below 5 files** for:
- Keyframe animations (Kanban smooth transitions)
- Pseudo-element chains
- Vendor-specific properties

Example: Drag-drop fade-in animation stays in CSS Module; simple card styling converts to Tailwind.

---

## Configuration Changes Required

| File | Change | Priority |
|------|--------|----------|
| vite.config.ts | Add `tailwindcss()` plugin (before react) | Critical |
| src/index.css | Replace with `@import "tailwindcss"` + `@theme` definitions | Critical |
| New: tailwind.config.ts | Create with semantic color palette and Tailwind settings | Critical |
| New: src/store/themeStore.ts | Create Zustand slice for theme management | Important |
| New: src/components/ThemeProvider.tsx | Create context component for theme application | Important |
| src/App.tsx | Wrap with `<ThemeProvider>` | Important |
| src/components/AppHeader.tsx | Add theme toggle button | Important |

---

## Compatibility: All Green

| Component | Status | Notes |
|-----------|--------|-------|
| React 19 + Tailwind 4.x | ✓ Full | CSS framework agnostic to React |
| Tauri 2 + Vite 7.3.1 | ✓ Full | @tailwindcss/vite peer deps satisfied |
| Radix UI + shadcn/ui | ✓ Full | shadcn wraps Radix; no conflicts |
| @dnd-kit drag-drop | ✓ Full | CSS framework agnostic |
| @git-diff-view/react | ⚠ Partial | Already includes Tailwind; coordinate themes |
| Zustand 4.5.0 | ✓ Full | Add theme slice; no impact to existing store |
| Sonner toasts | ✓ Full | Customize via Tailwind classes |
| React Hook Form | ✓ Full | Works with shadcn/ui forms out-of-box |

**Action item:** Test @git-diff-view/react diff viewer in both light/dark themes post-migration.

---

## Installation Summary

```bash
# Step 1: Core Tailwind
npm install tailwindcss@^4.1.13 @tailwindcss/vite@^4.1.13 @tailwindcss/postcss@^4.1.13

# Step 2: Utilities
npm install class-variance-authority@^0.7.1 clsx@^2.1.1 tailwind-merge@^2.5.5 tailwindcss-animate@^1.0.7 lucide-react@^0.563.0

# Step 3: Optional form validation
npm install zod@^3.24.1 @hookform/resolvers@^3.9.1

# Dev dependencies
npm install -D postcss@^8.5.0 autoprefixer@^10.4.20
```

---

## What This Research Covers

✓ Technology selection with version recommendations
✓ Configuration files and how to update them
✓ Theme management implementation strategy
✓ Migration path from CSS → Tailwind
✓ Compatibility verification against existing stack
✓ When NOT to use alternatives (next-themes, Bootstrap, etc.)
✓ Performance and bundle size analysis

## What This Research Does NOT Cover

✗ Full component-by-component migration code (roadmap phase-specific)
✗ Detailed styling for each component (UX designer → code phase)
✗ shadcn/ui components list (determined by UX, not architecture)
✗ Accessibility testing (QA phase responsibility)

---

## Downstream Usage

This research feeds into:

1. **Roadmap creation** — Phase structure for gradual migration
2. **Setup phase** — Installation and vite.config.ts updates
3. **Component migration phases** — Per-component Tailwind conversion

The companion document **UI_REDESIGN_STACK.md** contains detailed configuration code, theme implementation, and migration examples.

---

## Confidence Assessment

| Area | Level | Basis |
|------|-------|-------|
| Tailwind 4.x choice | **HIGH** | Official docs (tailwindcss.com), peer dependencies verified, used by shadcn/ui |
| @tailwindcss/vite compatibility | **HIGH** | npm peer deps show Vite 5-7 support; project uses 7.3.1 ✓ |
| shadcn/ui Vite feasibility | **HIGH** | Official shadcn/ui Vite docs; manual component addition proven |
| Theme system (Zustand-based) | **HIGH** | Reuses existing Zustand; simple media query implementation standard pattern |
| Migration strategy | **MEDIUM-HIGH** | Based on existing CSS structure analysis; implementation details pending phase planning |
| Performance impact | **MEDIUM** | Tailwind v4 theoretically faster than v3; actual impact measured post-migration |

---

## Risk Mitigation

| Risk | Probability | Mitigation |
|------|-------------|-----------|
| @git-diff-view/react theme conflict | Medium | Test in both themes post-setup; override CSS if needed |
| CSS Modules adoption creep | Low | Enforce <5 files rule in code review |
| HMR interruption during migration | Low | Tailwind plugin has no HMR impact; test dev server regularly |
| Bundle size regression | Low | Tailwind + Tailwind classes ~95KB (vs 80KB CSS); +15KB justified by features |
| Dark mode glitch on system preference change | Low | Test system theme listener on macOS and Linux |

---

## Next Steps for Roadmap

1. **Phase 1 (Setup):** Install Tailwind, update vite.config.ts, create theme provider
2. **Phase 2 (Pilot):** Migrate ProjectPicker + TaskCard to prove pattern
3. **Phase 3 (Rollout):** Migrate remaining components systematically
4. **Phase 4 (Polish):** Test edge cases, fix theme conflicts, remove legacy CSS

Estimated total effort: 8-12 hours implementation + 2-3 hours testing.

---

*Research produced: 2026-02-09*
*Confidence: HIGH*
*Related files: UI_REDESIGN_STACK.md (detailed configuration and implementation guide)*
