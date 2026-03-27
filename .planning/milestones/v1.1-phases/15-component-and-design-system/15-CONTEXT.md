# Phase 15: Component & Design System - Context

**Gathered:** 2026-02-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Migrate all reusable UI components to shadcn/ui and establish consistent design tokens (colors, fonts, spacing) across the entire application. Phase 14 provided theme infrastructure — this phase applies it everywhere. New features and page-level layouts belong in Phase 16.

</domain>

<decisions>
## Implementation Decisions

### Component Migration Scope
- **Comprehensive migration:** Button, Card, Input, Dialog, Badge, Select, Checkbox, Radio, Switch, Label, Textarea, Dropdown, Tabs, Popover, Tooltip — maximize shadcn/ui adoption in Phase 15
- **Specialized components (Kanban drag-drop, terminal output):** Wrap custom logic in shadcn container components (Card, etc.) for consistent styling chrome while preserving custom behavior
- **Customization approach:** Modify shadcn source components directly in `src/components/ui/` — simpler, fewer layers, easier to trace (no wrapper components)

### Visual Density & Spacing
- **Overall density:** Comfortable (text-sm base, h-9 buttons, p-4 cards) — balanced between readability and information density, modern SaaS aesthetic
- **Consistency:** Same density tokens across all views (Kanban, Agent Monitor, Settings) — unified feel, simpler token system
- **Kanban cards:** Compact information display — title, status dot, skills badges. Click to see full details in modal. Maximize cards visible per column.
- **Agent Monitor spacing:** Standard spacing tokens (matching rest of app) — consistency over content maximization

### Color System & Accents
- **Accent color usage:** Interactive elements (buttons, links, focus rings, selected states) plus indicators (status dots, progress bars, notification badges) — accent as primary brand color
- **Semantic colors:** Independent from accent — green (success), red (error), yellow/amber (warning), fixed colors for predictable meaning
- **Status indicators (Kanban):** Semantic color mapping — Backlog (gray), Ready (blue), InProgress (yellow/amber), Review (purple), Done (green) — status meaning clear at a glance
- **Contrast target:** WCAG AA minimum (4.5:1) — meet accessibility standard without over-contrasting, allows for subtler UI hierarchy
- **Accent color source:** System accent only (from OS preferences) — no custom override, respects user's system-wide choice
- **Terminal output colors:** Traditional ANSI colors (bright green, cyan, etc.) — familiar to developers, maintains terminal aesthetic
- **Background elevation:** Subtle elevation with 2-3 shades between app background, card background, and elevated elements — minimal depth cues

### Typography Hierarchy
- **Font usage:** FiraCode (monospace) for terminal output, code blocks, file paths only. Inter (UI font) for all UI text, buttons, labels, descriptive content.
- **Size scale:** Moderate hierarchy — text-sm body, text-base subheadings, text-lg headings, text-xl page titles (4-step scale)
- **Weight hierarchy:** Full variation — regular (400) for body text, medium (500) for subheadings, semibold (600) for headings
- **Kanban card typography:** Title-dominant — task title text-base semibold (focal point), everything else text-xs regular (metadata, skills, status)

### Claude's Discretion
- **CSS file deletion timing:** Decide whether to delete old CSS immediately after migration or keep temporarily during Phase 15 based on migration complexity and reference need
- **Typography fine-tuning:** Line heights, letter spacing, and fallback fonts for optimal readability
- **Component variant naming:** Internal naming conventions for size/variant props on customized shadcn components

</decisions>

<specifics>
## Specific Ideas

- "Comfortable density" means readable for extended use without feeling cramped, but not wasteful of screen space
- Kanban cards should minimize visual noise — title jumps out, details recede until clicked
- System accent color integration makes the app feel native and personalized without adding complexity
- Terminal output should feel like a terminal (ANSI colors) but UI chrome around it should match design system

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 15-component-and-design-system*
*Context gathered: 2026-02-10*
