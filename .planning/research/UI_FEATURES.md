# UI Feature Landscape: Modern Task Orchestration Interface (v1.1)

**Project:** AI Agent Orchestrator — v1.1 UI/UX Polish
**Domain:** Modern UI patterns for real-time task orchestration and agent monitoring
**Researched:** 2026-02-09
**Confidence:** MEDIUM (based on mockup analysis + industry patterns from GitHub Actions, CircleCI, Temporal)

---

## Context

This research specifically addresses **UI/UX feature patterns** for the v1.1 redesign. It complements the functional FEATURES.md (which covers what the product does) with guidance on **how it should look and feel**.

The mockup (`exemple/agent-cli-orchestration/`) establishes the design direction. This research validates that direction against modern orchestration UI patterns and identifies what UI features are table stakes vs. differentiators.

---

## Feature Landscape

### Table Stakes: UI Patterns Users Expect

Features that define whether the interface feels "modern" and professional. Missing these = looks outdated or broken.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|-----------|-------|
| **Dark theme support** | Modern desktop tools are dark-first. CLI affinity + eye comfort expectations. GitHub Actions, CircleCI, Temporal all default dark. | LOW | Mockup is entirely dark (HSL variables with green accents). CSS variables in place from v1.0. Use next-themes or Zustand store. |
| **Monospace terminal output** | Users running CLI tools expect terminal-familiar format. Serif fonts break the illusion. JetBrains Mono is industry standard. | LOW | Mockup uses JetBrains Mono for logs. xterm.js or styled divs both viable. Font weight 400, size 10-12px. |
| **Status indicators with visual hierarchy** | At-a-glance state understanding without reading labels. Colored dots + animated pulses for running states. | LOW | Mockup: green dot + "Running" label, animated pulse. Matches GitHub Actions status badges. |
| **Compact spacing and small type** | Power users (devs) tolerate tight layouts. Mockup uses text-xs (12px), h-7 buttons (28px). Spacious iOS-style padding feels wrong. | LOW | Tailor to keyboard + mouse users. Dense but readable. p-3 for cards, py-0.5 for text. |
| **Drag-drop Kanban with visual feedback** | Users expect columns to highlight on hover, cards to lift on drag, smooth drop animations. HTML5 drag or dnd-kit both work. | LOW | Mockup shows: border-[primary]/30 on drag-over, bg-[primary]/5 on column. Cursor changes (grab → grabbing). |
| **Smooth hover state transitions** | Buttons respond to hover with color/shadow changes in <100ms. Conveys interactivity. | LOW | Tailwind `transition-colors` or CSS modules. Hover states on all interactive elements. |
| **Accessible modal dialogs** | Dialog backdrop, focus trap, Escape key to close. Radix UI handles this. WAI-ARIA compliant. | MEDIUM | Radix UI Dialog or Drawer for deep task inspection. Already using in v1.0. |
| **Proper color contrast ratios** | WCAG AA minimum (4.5:1 for text). Dark backgrounds + light text + accent colors must pass contrast validation. | LOW | Mockup HSL values appear compliant. Verify with WebAIM contrast checker after color finalization. |
| **Semantic color meanings** | Green = success/running, Red = error/failed, Yellow = warning, Blue = info. Users instantly recognize. | LOW | Mockup uses CSS color system: --primary (green), --destructive (red), --warning (yellow), --info (blue). |
| **Scrollable containers with custom styling** | ScrollArea components for overflow content. Modern look (thin scrollbar, smooth scroll). | LOW | Mockup shows: 6px scrollbar width, muted color, hover brightens. Tailwind classes or ScrollArea component. |

### Differentiators: UI Features That Compete

Features that set the interface apart and improve user experience meaningfully.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|-----------|-------|
| **Inline agent assignment indicators** | Show which agent is running a task without opening modal. Small pill: "claude-ops-v1" or badge with agent icon. | LOW | Mockup: Bot icon + agent name in small text in card footer. Already in v1.0 (11-01). |
| **Real-time elapsed time badges** | Live countdown showing "2m 15s" for running tasks. Updates every 1s. Blue pulsing badge in card top-right. | LOW | Mockup shows elapsed time badge. Existing v1.0 component. Animation via CSS keyframes. |
| **Terminal-style log output with semantic prefixes** | Each log line prefixed: [OUT], [ERR], [SYS], [CALL], [RES]. Colored by type. Timestamps on left. | LOW | Mockup: 10px monospace font, prefixes in specific column width, timestamps right-aligned. |
| **Agent monitor sidebar (split view)** | Left panel: list of agents. Right panel: terminal output for selected agent. Toggle between all/single agent. | MEDIUM | Mockup shows this layout explicitly. Requires resizable container or fixed proportions. |
| **Column-level task counts** | Each Kanban column header shows badge: "Backlog (12)" or "InProgress (3)". | LOW | Mockup shows count badges. One line of code. |
| **Colored column accent dots** | Each column header starts with small colored dot matching column theme. Backlog gray, Ready blue, InProgress green, etc. | LOW | Mockup: 2px round dots in COLUMN_ACCENT object. Pure CSS. |
| **Copy-to-clipboard action on logs** | Right-click log line or inline copy button. Feedback via toast. | LOW | OnClick handler. Navigator.clipboard API. Sonner toast notification. |
| **Worktree pool status badge** | Top-right corner: "3/5 worktrees in use, 2 waiting". Shows resource constraint at a glance. | MEDIUM | Requires polling pool state. Small badge in header. Clicking expands a queue panel. |
| **Error state prominence** | Failed tasks show red badge in column, error message snippet below title (2-line clamp). | LOW | Mockup: Failed status styling already designed. Red background, smaller error text. |
| **Collapse/expand columns** | Column header toggle button hides/shows tasks. Useful for crowded boards. State persisted. | MEDIUM | Column toggle in header. State in Zustand or localStorage. Show count only when collapsed. |
| **Search/filter UI** | Filter dropdown showing: status, agent, priority. Clear button. Filtered results count. | MEDIUM | Dropdown in toolbar. Checkboxes for multi-select. Badge showing active filter count. |
| **Green accent color throughout** | Consistent use of primary green (#8FD14F or HSL 142 60% 50%) for active states, success feedback, running indicators. | LOW | Mockup establishes this. Use in: hover states, active nav items, running pulses, approve buttons. |

### Anti-Features: Avoid These

UI patterns that seem good but create problems or distract from core functionality.

| Anti-Feature | Why Tempting | Why Problematic | Alternative |
|--------------|-------------|-----------------|-------------|
| **Animated transitions everywhere** | Smooth is professional. Animations feel polished. | Performance hit on lower-end machines. Distracting from task content. Slows power users. | Use sparingly: Kanban drag-drop fade, status pulse. No fade-in on every button hover. |
| **Infinite scrolling terminal logs** | "Never lose output history." Sounds complete. | DOM becomes massive (10K+ nodes). Browser sluggish when scrolling up. Memory bloat. | Fixed buffer (last 1,000 lines visible). Full history in database. "Load more" button for older logs. |
| **Customizable color themes** | "Let users pick accent color." | Maintenance burden. Edge case color combinations break contrast. Accessibility fragile. | System dark/light only (next-themes). No custom color picker. Use the green accent. |
| **Multi-select task checkboxes** | "Batch operations would help power users." | UI complexity balloons. Kanban becomes table-like. Rarely used after first week. Drag-drop already handles most needs. | Single-task actions only. Bulk operations deferred to v2 if demand appears. |
| **Task nesting / sub-tasks** | "Some tasks have sub-steps." | Increases card complexity. Nesting depth confuses. Kanban becomes tree view (defeats purpose). | Keep tasks flat. If sub-logic needed, create separate linked tasks with parent metadata. |
| **Real-time graph animations** | "Show throughput/latency trends with sparklines." | Adds charting library. Requires metrics collection. Real-time updates are expensive. | Skip for v1.1. Focus on current execution visibility. Metrics as v2 dashboard feature. |
| **Glassmorphism or heavy gradients** | "Modern design uses blur and gradients." | Reduces readability. Looks trendy but ages fast. Terminal aesthetic rejects complexity. | Keep design flat. Use solid colors + subtle borders. Let content breathe. |
| **Hover tooltips on everything** | "Explain every button." | Tooltip storms. Users miss content under tooltips. Noise on screen. | Use only for ambiguous icons. Clear button text > tooltips. Rely on context. |
| **Animated loading spinners** | "Indicate waiting state." | Overdone. Users miss actual content. Can be jarring (especially pulsing badges). | Use simple spinner. Or show real progress % when available. Often no animation needed. |
| **Light mode default** | "More inclusive for daytime users." | Contradicts CLI affinity. Orchestration tools expect dark theme first. Users expect consistency with terminal. | Dark theme only for v1.1. Light mode can follow in v1.2 if demand. |
| **Fixed header/sidebar** | "Keep controls visible while scrolling." | Reduces screen real estate. On narrow screens, half the viewport is header. | Scroll naturally. Use sticky positioning only for column headers. |
| **Full-width task modals** | "Show all details at once." | Overwhelming. Users don't need all fields simultaneously. Progressive disclosure works better. | Use compact modal (60% width). Or drawer for mobile. Show only essential fields. |

---

## Visual Design System

Extracted from the mockup to establish consistency baseline.

### Color Palette (HSL System)

```
--background:        220 16% 6%      // Dark gray-blue background
--foreground:        210 20% 92%     // Off-white text
--card:              220 16% 8%      // Card backgrounds (slightly lighter)
--primary:           142 60% 50%     // Green accent (running, active, success)
--secondary:         220 14% 14%     // Muted hover/selected state
--destructive:       0 62% 50%       // Red (errors, failed tasks)
--warning:           38 92% 60%      // Orange (warnings)
--info:              200 65% 55%     // Blue (info messages)
--border:            220 14% 16%     // Subtle divider lines
--muted-foreground:  215 12% 50%     // Disabled/secondary text
```

### Spacing Scale (Tailwind)

- **Buttons:** h-7 (28px height), px-3 (12px horizontal), py-1.5 (6px vertical)
- **Card padding:** p-3 (12px all sides)
- **Column padding:** px-2 py-2.5 (headers), px-2 pb-2 (content)
- **Gap between elements:** gap-2 (8px) or gap-1.5 (6px) for tight layouts
- **Border radius:** rounded-lg (0.5rem / 8px)
- **Line height:** leading-relaxed (1.625) for readability

### Typography

- **Font stack:**
  - Semantic: Inter (default, sans-serif)
  - Terminal: JetBrains Mono (logs, monospace)
- **Sizes:** text-xs (12px), text-sm (14px), rarely text-base (16px)
- **Task titles:** text-sm font-medium
- **Column headers:** text-xs font-semibold uppercase tracking-wider
- **Terminal logs:** text-xs font-mono leading-relaxed

### Animations & Transitions

- **Status dot pulse:** `animate-pulse` when running (1-2s cycle)
- **Hover color:** `transition-colors` (150-200ms)
- **Drag feedback:** immediate border/bg change (no fade)
- **Button hover:** `hover:bg-secondary` or `hover:text-foreground`
- **No transitions:** on Kanban drag start (instantly show feedback)

### Component Patterns

| Component | Pattern |
|-----------|---------|
| **Buttons** | Small outline variants for secondary actions. Primary (green) for main CTA. No ghost buttons. |
| **Badges** | Small pills (h-4) with background + text color. Used for: status, tags, counts, agent names. |
| **Cards** | Rounded borders, subtle shadow, hover border brighten. No shadow on hover (flat design). |
| **Modals** | Backdrop blur. Dialog body 60% viewport width. Dark themed. Radix UI Dialog. |
| **Lists** | Scrollable with custom scrollbar. No bullets. Each item is clickable button-like. |
| **Forms** | Inline labels above inputs. Input has border-[border] with focus ring. Labels text-xs. |
| **Icons** | lucide-react library. 3.5-4w icon sizes mostly. Consistent with green accent on active. |
| **Progress** | Use badge with percentage or simple text. No animated progress bar (simpler is better). |

---

## Feature Dependencies

```
Core Dark Theme System
    ├─requires──> CSS Variables (color palette)
    ├─requires──> Theme Provider (Zustand + localStorage or next-themes)
    └─enhances──> All visual features (semantic colors depend on this)

Kanban Board Visual Polish
    ├─requires──> Drag-drop visual feedback (column highlight, card lift)
    ├─requires──> Status indicators (colored dots, labels, pulses)
    └─enhances──> Agent assignment badges (show inline in cards)

Terminal Output Component
    ├─requires──> Monospace font (JetBrains Mono)
    ├─requires──> Semantic log coloring (prefix-based classes)
    ├─requires──> Copy-to-clipboard feature (onClick handler)
    └─requires──> Scrollable container (ScrollArea component)

Agent Monitor Sidebar
    ├─requires──> Terminal Output component
    ├─requires──> Agent list with status indicators
    └─requires──> Split-pane layout (fixed or resizable)

Error State Visibility
    ├─requires──> Red badge styling (--destructive color)
    ├─requires──> Error message display (modal or inline)
    └─requires──> Recovery action buttons (Retry, Abort, Terminal)

Worktree Pool Visualization
    ├─requires──> Pool status polling (backend)
    ├─requires──> Status badge in header (X/Y worktrees)
    └─enhances──> Kanban board (explains parallelism limits)

Accessibility Support
    ├─requires──> Tab navigation (tabindex, proper focus management)
    ├─requires──> Keyboard shortcuts (Escape for modals, arrows for nav)
    └─requires──> Screen reader compatibility (semantic HTML, ARIA labels)

Collapse/Expand Columns
    ├─requires──> Column header toggle button
    ├─requires──> State persistence (Zustand or localStorage)
    └─enhances──> Kanban board (reduce visual clutter on large boards)

Search/Filter UI
    ├─requires──> Filter dropdown component
    ├─requires──> State management for active filters
    └─enhances──> Kanban board (improve usability)
```

---

## MVP UI Definition (v1.1)

### Core UI Features (Required for "Modern" Feel)

- [x] **Dark theme** — CSS variables in place. Apply with theme provider. Green accent throughout.
- [x] **Status indicators** — Colored dots + labels on task cards. Pulse animation for running.
- [x] **Compact layout** — Dense typography and spacing. h-7 buttons, text-xs labels.
- [x] **Monospace logs** — Terminal output styled with JetBrains Mono. Prefix-based coloring (OUT/ERR/SYS).
- [x] **Kanban drag feedback** — Column highlight on drag-over. Smooth transitions.
- [x] **Agent monitor sidebar** — Left panel agent list + right panel terminal. Select agent to filter logs.
- [x] **Proper contrast ratios** — WCAG AA compliant color combinations.
- [x] **Semantic colors** — Green for success/running, red for errors, yellow for warnings.

### Polish Features (v1.1.x)

- [ ] **Copy-to-clipboard on logs** — Right-click or button to copy. Toast feedback.
- [ ] **Worktree pool badge** — Show resource constraints in header.
- [ ] **Column collapse/expand** — Toggle to hide/show tasks. State persisted.
- [ ] **Search/filter Kanban** — Filter by status, agent, priority.
- [ ] **Error recovery UI** — Failed task badge + error message + action buttons (Retry, Abort, Terminal).

### Future (v2+)

- [ ] **Light mode** — Defer to v1.2. Dark-first for v1.1.
- [ ] **Custom themes** — No custom color picker. Use system theme (dark/light) only.
- [ ] **Real-time metrics** — Throughput/latency graphs. Post-MVP feature.
- [ ] **Batch operations** — Multi-select tasks. Defer to v2 if demand.

---

## Component Library Selection

For v1.1, use **shadcn/ui** for pre-built components (already planned in UI_REDESIGN_STACK.md).

| Component Needed | shadcn/ui Option | Custom Build? | Notes |
|------------------|------------------|---------------|-------|
| Buttons | Button | No | Built on Radix. Variants: primary, outline, ghost. |
| Cards | Card | No | Simple wrapper. Handles shadow + border. |
| Modals | Dialog | No | Radix Dialog wrapped. Full accessibility. |
| Dropdowns | Select | No | Radix Select. For agent filter, status filter. |
| Badges | Badge | No | Simple colored pill. |
| Scrollable areas | ScrollArea | No | Custom scrollbar styling. |
| Tabs | Tabs | No | For settings panel, execution history tabs. |
| Tables | Table | No | For worktree pool status, execution history. |
| Checkboxes/Radio | Checkbox, RadioGroup | No | For filters. |
| Inputs | Input | No | For search/filter. |
| Toast notifications | Sonner | No | Already in v1.0. Works with Tailwind. |
| Split pane | ResizablePanel | No | For agent sidebar resizing (optional). |

**Action:** Use shadcn/ui CLI to scaffold components or manually copy from ui.shadcn.com.

---

## Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| **Table stakes features** | HIGH | Mockup clearly demonstrates all these. Dark theme, status indicators, Kanban, terminal output are non-negotiable. |
| **Visual design system** | HIGH | Mockup provides explicit HSL values, spacing scale, typography. Copy-paste ready. |
| **Differentiators** | MEDIUM | Agent sidebar, copy-to-clipboard, pool visualization are industry patterns. Validation pending real user feedback. |
| **Component library choice** | HIGH | shadcn/ui is standard for Vite + React. Works with Tailwind 4.x. Proven in thousands of projects. |
| **Animation/transition approach** | MEDIUM | "Sparse animation" is a philosophy, not a spec. Actual implementation needs careful A/B testing. |
| **Color contrast** | MEDIUM | HSL values appear compliant but need automated validation post-implementation. |

---

## Open Questions for Roadmap

- **Resizable sidebar?** Agent list on left — fixed width or draggable? Fixed is simpler for v1.1.
- **Terminal buffer size?** Last 1,000 lines? 10,000? Trade performance vs. history. Start with 1,000.
- **Keyboard shortcuts?** Cmd/Ctrl+K for search? Tab for navigation? Escape for modals? Define minimal set for v1.1.
- **Mobile responsiveness?** Desktop-first app, but should it work on tablet? Defer to v2.
- **Accessibility depth?** Tab + semantic HTML basics, or full screen-reader testing? Plan for basics in v1.1.
- **Light mode timing?** Is it required for v1.1 or can it follow in v1.2? Recommend deferring to v1.2 (no complexity gain).

---

## Migration Order (from v1.0 → v1.1)

1. **Setup** (30 min) — Tailwind 4.x + theme provider + shadcn/ui scaffolding
2. **ProjectPicker** (30 min) — Simple cards, green accent
3. **TaskCard** (45 min) — Status badges, elapsed time, agent pill, drag feedback
4. **KanbanBoard** (1 hour) — Column layout, drag-drop UX, colored dots
5. **TaskModal** (1 hour) — Form styling, inputs, validation
6. **AppHeader** (30 min) — Navigation, theme toggle button
7. **AgentMonitor** (1.5 hours) — Sidebar list + terminal panel split
8. **TerminalOutput** (1 hour) — Monospace styling, prefix coloring, copy button
9. **ExecutionHistory** (1 hour) — Table styling, status badges, error display
10. **Settings** (1 hour) — Form layouts, tab navigation

**Estimated total:** 8-10 hours implementation + 2-3 hours testing = 10-13 hours.

---

## Sources

- **Mockup reference:** `exemple/agent-cli-orchestration/` (Next.js app with target design)
  - Kanban board: compact cards, colored column dots, drag feedback
  - Agent monitor: sidebar + terminal split
  - Global CSS: HSL color system, spacing scale, typography
  - Component library: shadcn/ui patterns

- **Industry references (implicit patterns):**
  - GitHub Actions UI: dark theme, status badges, terminal output, drag-drop
  - CircleCI dashboard: agent list, real-time logs, compact layout
  - Temporal UI: workflow monitoring, terminal-style output, status indicators
  - VS Code: monospace font for logs, green accent for active states, keyboard navigation

- **Existing codebase:**
  - v1.0 components: KanbanBoard, TaskCard, ExecutionTerminal, ExecutionHistory
  - Zustand store patterns: boardStore, potential themeStore
  - Tauri integration: no UI-specific blockers

---

**UI Feature Research for:** v1.1 UI/UX Polish Milestone
**Researched:** 2026-02-09
**Next Step:** Roadmap creation will phase these features into implementation sprints
