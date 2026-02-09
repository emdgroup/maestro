# UI Redesign Research Summary

**Project:** GSD Agent Orchestrator v1.1 UI/UX Polish
**Domain:** Desktop app UI framework modernization (Tailwind CSS + shadcn/ui integration in Tauri 2)
**Researched:** 2026-02-09
**Confidence:** HIGH

## Executive Summary

The v1.1 redesign should standardize on **Tailwind CSS 4.1 + @tailwindcss/vite + shadcn/ui 0.9.5+** as the UI framework, replacing hand-written CSS with a utility-first approach. This modernization improves consistency, maintainability, and bundle size (5kB savings) while maintaining the existing Tauri + React 19 stack. The design itself is already established in the mockup (`exemple/agent-cli-orchestration/`) with dark-first theme, green accent color, monospace terminal output, and modern status indicators.

The migration introduces moderate risk primarily from CSS conflicts during transition and dynamic class name purging in Tailwind production builds. These risks are well-understood and preventable through careful phase planning and testing. The recommended approach is incremental component-by-component migration with parallel CSS systems during transition, phased deletion of old CSS files, and production build validation at each step.

Key risks are manageable: dynamic class names can be audited and refactored, CSS conflicts can be isolated by renaming old files, and theme persistence can use Tauri's store API instead of localStorage. The architecture is proven in thousands of production apps and integrates seamlessly with existing dnd-kit drag-drop, Radix UI Dialog, and Sonner toast components.

## Key Findings

### Recommended Stack

From STACK.md, the recommended technology approach prioritizes production efficiency and developer experience:

**Core technologies:**
- **Tailwind CSS 4.1.18** — Utility-first CSS generation with @tailwindcss/vite plugin. Chosen over v3 for 8kB bundle savings, faster HMR in dev mode, and simpler Vite integration (no PostCSS config needed).
- **@tailwindcss/vite 4.1.18** — Vite plugin for Tailwind. Replaces PostCSS setup, native HMR support in Tauri dev mode, smaller bundle output.
- **shadcn/ui 0.9.5+** — Pre-built, accessible Radix UI components styled with Tailwind. Copy-paste architecture (not npm dependency), theme-aware via CSS variables. 80+ components covers buttons, forms, dialogs, tables, badges.
- **class-variance-authority 0.7.1** — Component variant composition for flexible, typed component APIs (e.g., `button({ variant: 'primary', size: 'sm' })`).
- **next-themes** — Theme provider for light/dark mode switching. Works in non-Next.js React. Persists to localStorage and provides system preference detection.
- **CSS Modules (hybrid)** — For complex layouts, animations, and edge cases where Tailwind utilities feel verbose. Colocated with components.

**Removed (no longer needed):**
- Hand-written global CSS files (index.css, component-level CSS)
- CSS color variables (legacy approach)
- Custom buttons, form inputs, modals (replaced by shadcn/ui)

### Expected Features

From UI_FEATURES.md, the feature landscape defines what makes the interface feel "modern" vs. what's competitive:

**Must have (table stakes — define "modern UI"):**
- Dark theme support (CSS variables, next-themes or Zustand store)
- Monospace terminal output (JetBrains Mono font, 10-12px size)
- Status indicators with visual hierarchy (colored dots, animated pulse for running)
- Compact spacing (power-user friendly, text-xs/h-7)
- Drag-drop Kanban with visual feedback (column highlight, card lift, smooth transitions)
- Smooth hover state transitions (<100ms via CSS)
- Accessible modal dialogs (Radix UI, focus trap, Escape key)
- Proper color contrast (WCAG AA, 4.5:1 minimum)
- Semantic color meanings (green=success, red=error, yellow=warning, blue=info)
- Scrollable containers with custom styling (thin scrollbar, muted color)

**Should have (differentiators):**
- Inline agent assignment indicators (small pill in card footer)
- Real-time elapsed time badges (1s updates, blue pulsing)
- Terminal-style log output with semantic prefixes ([OUT], [ERR], [SYS], [CALL], [RES])
- Agent monitor sidebar (split view: left agent list, right terminal output)
- Column-level task counts (badge showing count per status)
- Colored column accent dots (visual consistency with status)
- Copy-to-clipboard on logs (right-click or button, toast feedback)
- Worktree pool status badge (resource constraint visibility)
- Error state prominence (red badge, error message snippet)
- Collapse/expand columns (toggle to hide/show, state persisted)
- Search/filter UI (status, agent, priority dropdowns)

**Anti-features to avoid:**
- Animated transitions everywhere (distracting, performance hit)
- Infinite scrolling terminal logs (DOM bloat, browser lag)
- Customizable color themes (maintenance burden, accessibility fragile)
- Multi-select task checkboxes (UI complexity, rarely used)
- Task nesting/sub-tasks (defeats Kanban purpose)
- Real-time graph animations (expensive, defer to v2)
- Glassmorphism or heavy gradients (reduces readability, ages fast)
- Hover tooltips on everything (tooltip storms)
- Animated loading spinners (overdone, jarring)
- Light mode as default (contradicts CLI affinity, dark-first better)
- Fixed header/sidebar (reduces screen real estate)
- Full-width task modals (overwhelming, compact modal better)

### Architecture Approach

From ARCHITECTURE.md, the technical structure keeps existing React + Tauri integration intact while layering modern UI tooling:

**System layers (bottom to top):**
1. **React Components Layer** — App-specific components (KanbanBoard, TaskCard, etc.)
2. **Tailwind + CSS Modules Layer** — Utility CSS generation + scoped component styles
3. **Theme Provider Layer** — next-themes for theme state + localStorage persistence
4. **Build & Configuration Layer** — Vite + @tailwindcss/vite + PostCSS (optional)

**Major components:**
1. **shadcn/ui components** (`src/components/ui/`) — Third-party pre-built components, theme-aware via CSS variables
2. **App-specific components** (`src/components/`) — KanbanBoard, TaskCard, ProjectPicker, AgentMonitor, etc.
3. **Tailwind utilities** — Layout, spacing, typography, colors via class names
4. **CSS Modules** — Component-specific one-off styles (animations, complex layouts)
5. **ThemeProvider** — Wraps entire app, manages theme state + localStorage/Tauri store
6. **Vite + @tailwindcss/vite** — Compiles Tailwind utilities at dev/build time

**Key patterns:**
- **Hybrid Tailwind + CSS Modules** — Tailwind for 90% of styling, CSS Modules only for complex state-based styles or animations
- **Theme Provider at Root** — Single source of truth for theme state via `useTheme()` hook
- **CSS Variables for Colors** — Tailwind 4's @theme directive, updates dynamically without rebuilding
- **Data-Attribute Dark Mode** — Use `data-theme="dark"` instead of class (cleaner for desktop apps)
- **Incremental Component Migration** — Convert components one-by-one, keeping old CSS files until replacement complete

### Critical Pitfalls

From PITFALLS.md, the top risks and mitigation strategies:

1. **Dynamic Class Names Purged by Tailwind** — Tailwind scans source for static class strings. Runtime-constructed classes are removed in production builds. **Mitigation:** Always use static class strings (e.g., `error ? 'text-red-600' : 'text-green-600'`), use safelist config for predictable values, or use CSS variables with inline styles for truly dynamic values.

2. **Theme Flash on App Startup** — Tauri app renders light theme by default, then dark CSS loads after React renders, causing visible flicker. **Mitigation:** Inject theme detection script in `<head>` BEFORE React loads (synchronous, runs before render), configure Tailwind for class-based dark mode, use Tauri system theme detection API on startup.

3. **CSS Conflicts Between Old and New** — Hand-written CSS (specificity wars) conflicts with Tailwind utilities during migration. **Mitigation:** Migrate components completely (don't mix systems), rename old CSS files to `.migrate-old.css` (exclude from build), use CSS layers to control specificity, keep CSS Modules only for animations/complex selectors.

4. **Content Configuration Missing or Incorrect** — Tailwind doesn't scan all source files, so classes are purged in production. Works in dev, fails in production. **Mitigation:** Verify `content` glob patterns in `tailwind.config.ts` match file structure, test production build locally (`pnpm build && pnpm preview`), ensure @tailwindcss/vite plugin present in vite.config.ts.

5. **Radix UI Unstyled Components** — Radix components ship unstyled by design. Adding Radix directly without CSS leaves components broken-looking. **Mitigation:** Use shadcn/ui wrappers (already styled with Tailwind), or manually add Tailwind classes if using Radix directly.

## Implications for Roadmap

Based on research dependencies, suggested phase structure for v1.1 UI redesign:

### Phase 1: Tailwind + Theme Foundation (1-1.5 days)
**Rationale:** Must establish CSS framework and theme system before components can be styled. Theming requires synchronous setup to avoid flash-of-unstyled-content on startup.

**Delivers:**
- Tailwind 4.1 installed + @tailwindcss/vite plugin configured in vite.config.ts
- tailwind.config.ts with CSS variables for color palette (dark theme default)
- Theme detection script injected in index.html (prevents flash)
- next-themes integrated with ThemeProvider wrapper in App.tsx
- CSS entry point (src/index.css) with `@import "tailwindcss"`
- shadcn/ui initialized with components.json

**Addresses features:** Dark theme support, semantic colors

**Avoids pitfalls:** Theme flash, missing content config, missing @tailwindcss/vite plugin, CSS conflicts (by establishing Tailwind as primary system)

**Research flags:** NONE — all patterns well-documented in official Tailwind/shadcn/next-themes docs

### Phase 2: Core Component Migration (2-3 days)
**Rationale:** Once foundation is ready, migrate most-used components to shadcn/ui. Establishes pattern for remaining components. Focus on components used across multiple pages (Button, Card, Input, Dialog, Badge).

**Delivers:**
- Button from shadcn/ui (replaces custom button CSS)
- Card from shadcn/ui (replaces custom card styling)
- Dialog from shadcn/ui (already using Radix, seamless swap)
- Input from shadcn/ui (for forms, search filters)
- Badge from shadcn/ui (status indicators, tags)
- Select from shadcn/ui (for dropdowns, filters)
- Delete corresponding old CSS files (button.css, card.css, etc.)

**Addresses features:** Table stakes UI features (clean component baseline)

**Avoids pitfalls:** Radix UI unstyled components, CSS conflicts (by deleting old files after migration)

**Research flags:** NONE — shadcn/ui copy-paste workflow is standard

### Phase 3: Page Layout Redesign (2-3 days)
**Rationale:** With core components ready, redesign main pages using Tailwind utilities + shadcn components. Focus on dense, compact layout (mockup shows text-xs, h-7 buttons, minimal padding).

**Delivers:**
- ProjectPicker redesigned (simple cards, green accent on hover)
- KanbanBoard redesigned (columns with accent dots, drag-drop visual feedback)
- TaskCard redesigned (status badge, agent pill, elapsed time badge, error state)
- TaskModal redesigned (form styling, inputs, validation feedback)
- AppHeader redesigned (navigation, theme toggle button)

**Implements architecture patterns:** Hybrid Tailwind + CSS Modules (for Kanban animations), CSS variables for theme colors

**Addresses features:** Kanban drag feedback, status indicators, compact spacing, monospace logs (setup), semantic colors, column task counts, error state prominence

**Avoids pitfalls:** Dynamic class names (audit all interpolations), CSS Modules naming conflicts (use distinct names like `.cardContainer` not `.p4`)

**Research flags:** NONE — layout patterns well-established

### Phase 4: Terminal & Agent Monitor (1.5-2 days)
**Rationale:** Terminal output and agent monitor are isolated components with special styling needs. Keep CSS Modules for xterm styling complexity.

**Delivers:**
- TerminalOutput component redesigned (JetBrains Mono font, 10-12px size, semantic prefix coloring)
- ExecutionHistory table restyled with shadcn Table component
- AgentMonitor sidebar implemented (split pane: agent list + terminal output)
- Copy-to-clipboard on logs (onClick handler + Sonner toast)
- Monospace terminal CSS in module files (justified complexity)

**Implements architecture:** CSS Modules for terminal complexity, shadcn Table component

**Addresses features:** Monospace logs, semantic log prefixes, agent monitor sidebar, copy-to-clipboard, scrollable containers

**Avoids pitfalls:** Using Radix Dialog unstyled (use shadcn wrapper)

**Research flags:** NONE — terminal styling is common pattern

### Phase 5: Polish & Testing (1-2 days)
**Rationale:** Final pass on responsive design, dark mode edge cases, contrast validation, and QA.

**Delivers:**
- Responsive design validated (Tailwind breakpoints match mockup)
- Dark mode toggle tested (persists correctly, no flash on reload)
- Color contrast validated (WebAIM checker or Lighthouse)
- Production build tested locally (`pnpm tauri build`)
- Edge case styling fixed (hover states, focus rings, disabled states)
- Old CSS files fully deleted (single source of truth)

**Addresses features:** All table stakes + differentiators

**Avoids pitfalls:** Production build with purged classes (test prod build), unstyled production (verify all CSS present)

**Research flags:** NONE — testing is standard QA process

### Phase Ordering Rationale

1. **Foundation first (Phase 1):** Tailwind + theme system must exist before any component can be styled. Theming setup is a one-time cost, cannot be done incrementally.
2. **Core components second (Phase 2):** Button, Card, Input are used everywhere. Establishing pattern here unblocks page layouts.
3. **Page layouts third (Phase 3):** Major work is layout. Once components exist, assemble them into pages.
4. **Specialized components fourth (Phase 4):** Terminal and agent monitor have unique needs (CSS Modules justified). Isolated from main flow.
5. **Polish last (Phase 5):** Testing and edge cases come after main implementation. No blockers, just quality assurance.

### Research Flags

Phases needing deeper research during planning:
- **NONE identified** — All major patterns are well-documented in official Tailwind, shadcn/ui, and Vite docs. Tauri integration is straightforward (no special considerations beyond normal React).

Phases with standard patterns (skip research-phase):
- **Phase 1:** Tailwind + shadcn + next-themes integration is industry standard. Official docs cover all aspects.
- **Phase 2:** shadcn/ui copy-paste workflow is standard for hundreds of projects.
- **Phase 3:** Tailwind utilities + dnd-kit for drag-drop are well-established patterns.
- **Phase 4:** Terminal styling with CSS Modules is common in dev tools.
- **Phase 5:** Standard QA/testing (no research needed).

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| **Stack** | HIGH | Tailwind 4.1, shadcn/ui, next-themes all production-ready with millions of users. @tailwindcss/vite is official recommendation. Versions pinned as of 2026-02-09. |
| **Features** | HIGH | Mockup provides explicit visual design. Industry patterns from GitHub Actions, CircleCI, Temporal align with feature choices. Table stakes vs. differentiators clearly delineated. |
| **Architecture** | HIGH | Component layering, theme provider pattern, CSS variable approach all standard React practices. Integration with existing Tauri + Vite + React 19 stack verified against docs. |
| **Pitfalls** | HIGH | All pitfalls have well-documented prevention strategies from official sources (Tailwind docs, Vite docs, shadcn docs). Phase-specific warnings backed by community experience. |

**Overall confidence:** HIGH

All recommendations backed by official documentation and proven patterns in thousands of production apps. No experimental technologies. Only standard risks are CSS conflict management and dynamic class name auditing during migration—both preventable with careful process.

### Gaps to Address

1. **xterm.js terminal styling** — CSS Modules approach for xterm justified, but specific color scheme and syntax highlighting not detailed in research. Recommend creating xterm color theme matching Tailwind dark palette during Phase 4 implementation.

2. **Keyboard shortcuts** — UI_FEATURES.md notes "minimal keyboard shortcuts" but doesn't specify which keys. Recommend defining during Phase 3 planning (Escape for modals, Tab for nav, Cmd/Ctrl+K for search).

3. **Mobile responsiveness** — Research recommends deferring to v2. v1.1 is desktop-first only. If requirement changes, responsive design would add 1-2 days to Phase 3-5.

4. **Light mode timing** — Recommend deferring to v1.2. No technical blocker, but adds work for v1.1. Dark-first for v1.1, light mode follows if demand appears.

5. **Accessibility depth** — Phase 5 focuses on basic tab navigation and semantic HTML. Full screen reader testing deferred to post-launch. If needed, add 1 day to Phase 5.

## Sources

### Primary (HIGH confidence)
- **Tailwind CSS 4.1 Documentation** — https://tailwindcss.com (official, v4.1.18 release, @tailwindcss/vite plugin, dark mode, content configuration)
- **shadcn/ui Vite Setup** — https://ui.shadcn.com/docs/installation/vite (copy-paste workflow, components.json, path aliases)
- **next-themes GitHub** — https://github.com/pacocoursey/next-themes (client-side theming, localStorage persistence, system preference detection)
- **Vite Documentation** — https://vite.dev/config/ (HMR, plugin architecture, CSS module configuration)

### Secondary (MEDIUM confidence)
- **Mockup reference** — `exemple/agent-cli-orchestration/` (Next.js app with target design)
- **Industry references** — GitHub Actions UI, CircleCI, Temporal (implicit patterns for orchestration UI)

### Tertiary (RESEARCH FILES)
- **STACK.md** — Technology version matrix, migration path, bundle size analysis
- **UI_FEATURES.md** — Feature landscape, anti-features, visual design system, component library selection
- **ARCHITECTURE.md** — System layers, component responsibilities, data flow, build process, scaling considerations
- **PITFALLS.md** — 10 pitfalls with prevention strategies, phase-specific warnings, migration checklist

---

*Research completed: 2026-02-09*
*Synthesized by: Claude Code (GSD Research Synthesizer)*
*Ready for roadmap creation: YES*
