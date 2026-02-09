# Phase 14: UI Foundation - Context

**Gathered:** 2026-02-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Establish the CSS framework (Tailwind CSS 4.1 + @tailwindcss/vite) and complete theming system with no visual flash on startup. User can toggle between light, dark, and system theme with instant persistence across restarts.

</domain>

<decisions>
## Implementation Decisions

### Tailwind Configuration Scope
- Enable animation utilities (animate-pulse, animate-spin, etc.) for loading states and agent status indicators
- Use default breakpoints only (sm/md/lg/xl/2xl) — no custom breakpoints
- Minimal color palette — all colors from CSS variables, no hard-coded extensions in Tailwind config
- Enable container queries plugin (@container utilities) for split panes and card grids
- Skip @tailwindcss/forms plugin — let shadcn/ui handle all form styling
- No class prefix — use standard Tailwind classes (text-sm, bg-primary)
- Use default spacing scale (0.25rem increments) — no custom scale
- No safelist configuration — all classes appear in JSX/TSX templates

### Theme Toggle UI Placement
- Settings page only — no header shortcut
- Dropdown/Select control type
- Text labels only — no sun/moon/auto icons
- Silent update on theme change — no toast notification

### Theme Persistence Behavior
- Global setting across all projects — not per-project
- Read OS theme on startup only — no real-time tracking of OS theme changes
- Persist in SQLite settings table (consistent with other app settings)
- Default to system theme on first run (respects OS preference)

### Flash Prevention Strategy
- Use Tauri-specific preload/window initialization hooks to set theme before showing window
- Inject system accent color variables during preload (complete theme on startup)
- System theme fallback if preference read fails
- No transition delay — apply theme instantly on startup

### Claude's Discretion
- Exact Tailwind config file structure
- Theme provider implementation details
- Tauri window initialization hook specifics

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for Tailwind + next-themes + Tauri integration.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 14-ui-foundation*
*Context gathered: 2026-02-09*
