# Phase 16: Page Redesigns - Context

**Gathered:** 2026-02-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Redesign all major application pages (Kanban board, Agent monitor, Worktree manager, Settings panel, App header) with modern aesthetic matching mockup design. This phase transforms the visual presentation of existing functional pages — updating layouts, component styling, information hierarchy, and navigation structure. Feature functionality remains unchanged; focus is on visual polish and user experience.

</domain>

<decisions>
## Implementation Decisions

### Layout density & spacing
- **Overall density:** Balanced density — moderate spacing with readable text, balancing info density with breathing room (not power-user compact, not relaxed spacious)
- **Card styling:** Subtle depth — soft shadows, subtle borders, 8px rounded corners for modern feel without heaviness
- **Grid/list spacing:** Tight gaps (12-16px) — maximize visible content while maintaining clarity
- **Container padding:** Compact padding (12-16px) — fits more content with modern tight aesthetic

### Status visualization
- **Agent states:** Colored dots with gentle pulse animation for active states (running), static dots for idle
- **Worktree status:** Git status icon (clean checkmark, dirty dot) + branch name displayed prominently
- **Task status:** Small colored status dot on Kanban cards, with column position providing primary context (not full labels or progress bars)
- **Color palette:** Semantic standard colors — green=success/done, yellow=warning/review, red=error, blue=in-progress, gray=idle

### Interaction patterns
- **Hover effects:** Subtle lift — slight shadow increase + color brightness shift, responsive without distraction
- **Drag feedback:** Ghost + drop zone highlight — dragged item becomes semi-transparent, drop zones show colored border/background
- **Transition speed:** Snappy (150-200ms) — fast, responsive feel that doesn't slow user down
- **Focus states:** Subtle glow — soft box-shadow in accent color (not bold outline or accent ring)

### Navigation structure
- **Page switching:** Horizontal tab bar in app header, always visible, shows all pages (Kanban, Agent Monitor, Worktree Manager, Settings)
- **Active page indicator:** Background highlight on active tab (different background color from inactive tabs, not underline or bold)
- **Page transitions:** Instant swap — no animation, content changes immediately for fastest, clearest experience
- **Header context:** Show active project name + global status indicators (agents running count, worktrees count) alongside tabs

### Claude's Discretion
- Exact shadow values and color brightness shifts for hover effects
- Pulse animation timing and easing curves for agent status dots
- Specific icon choices for worktree status (checkmark, dot styles)
- Typography hierarchy within cards (font sizes, weights)

</decisions>

<specifics>
## Specific Ideas

No specific product references provided — open to standard modern UI patterns matching the decisions above. Focus on clean, professional aesthetic with shadcn/ui components and Tailwind utilities.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope (visual redesign of existing pages).

</deferred>

---

*Phase: 16-page-redesigns*
*Context gathered: 2026-02-10*
