# Phase 16: Page Redesigns - Research

**Researched:** 2026-02-10
**Domain:** Modern UI redesign with component-based styling
**Confidence:** HIGH

## Summary

This phase requires redesigning five major application pages (Kanban board, Agent monitor, Worktree manager, Settings panel, App header) with modern aesthetic matching locked design decisions. The research confirms that the existing tech stack (Tailwind CSS 4.1+, shadcn/ui, dnd-kit, @radix-ui) perfectly supports all planned visual patterns. The Phase 15 design system (semantic colors, typography, spacing scales) provides the foundation; Phase 16 applies these tokens consistently across all pages using Tailwind utilities and custom animations. Implementation leverages existing infrastructure with high confidence in success.

**Primary recommendation:** Use Tailwind animations (animate-pulse for status dots, transition utilities for hover effects), drop-zone styling with dnd-kit DragOverlay, and Radix Tabs (already integrated via shadcn/ui) for the header navigation bar.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Layout density & spacing:**
- **Overall density:** Balanced density — moderate spacing with readable text, balancing info density with breathing room (not power-user compact, not relaxed spacious)
- **Card styling:** Subtle depth — soft shadows, subtle borders, 8px rounded corners for modern feel without heaviness
- **Grid/list spacing:** Tight gaps (12-16px) — maximize visible content while maintaining clarity
- **Container padding:** Compact padding (12-16px) — fits more content with modern tight aesthetic

**Status visualization:**
- **Agent states:** Colored dots with gentle pulse animation for active states (running), static dots for idle
- **Worktree status:** Git status icon (clean checkmark, dirty dot) + branch name displayed prominently
- **Task status:** Small colored status dot on Kanban cards, with column position providing primary context (not full labels or progress bars)
- **Color palette:** Semantic standard colors — green=success/done, yellow=warning/review, red=error, blue=in-progress, gray=idle

**Interaction patterns:**
- **Hover effects:** Subtle lift — slight shadow increase + color brightness shift, responsive without distraction
- **Drag feedback:** Ghost + drop zone highlight — dragged item becomes semi-transparent, drop zones show colored border/background
- **Transition speed:** Snappy (150-200ms) — fast, responsive feel that doesn't slow user down
- **Focus states:** Subtle glow — soft box-shadow in accent color (not bold outline or accent ring)

**Navigation structure:**
- **Page switching:** Horizontal tab bar in app header, always visible, shows all pages (Kanban, Agent Monitor, Worktree Manager, Settings)
- **Active page indicator:** Background highlight on active tab (different background color from inactive tabs, not underline or bold)
- **Page transitions:** Instant swap — no animation, content changes immediately for fastest, clearest experience
- **Header context:** Show active project name + global status indicators (agents running count, worktrees count) alongside tabs

### Claude's Discretion

- Exact shadow values and color brightness shifts for hover effects
- Pulse animation timing and easing curves for agent status dots
- Specific icon choices for worktree status (checkmark, dot styles)
- Typography hierarchy within cards (font sizes, weights)

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope (visual redesign of existing pages).

</user_constraints>

## Standard Stack

### Core UI Foundation (Phase 15 Complete)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Tailwind CSS | 4.1+ | Utility-first CSS framework | Industry standard, zero-runtime, composable, powerful animations |
| shadcn/ui | Latest | Pre-built Radix UI components | Aligned with existing design system, accessible, customizable |
| @radix-ui/react-tabs | 1.x | Tab component primitive | Already integrated via shadcn/ui, accessible, controlled/uncontrolled modes |
| dnd-kit | 8.x | Drag-and-drop toolkit | Lightweight, performant, visual feedback support, already in use |

### Semantic Color System (Phase 15 Complete)

| Token | Usage | Example Value |
|-------|-------|---------------|
| `success` | Done status, green indicators | hsl(142 72% 29%) |
| `warning` | Review/in-progress, yellow indicators | hsl(38 92% 50%) |
| `error` | Failed status, red indicators | hsl(0 84% 60%) |
| `accent` | Interactive elements, system override | hsl(217 91% 60%) |
| `muted` / `muted-foreground` | Disabled, secondary text | Available via CSS variables |

### Typography System (Phase 15 Complete)

| Scale | Font | Usage |
|-------|------|-------|
| `xs` (0.75rem) | Inter | Badge text, timestamps, dense info |
| `sm` (0.875rem) | Inter | Card content, secondary text |
| `base` (1rem) | Inter | Body text, default UI text |
| `lg` (1.125rem) | Inter | Headers, card titles |
| `mono` | FiraCode | Terminal output, code, monospace contexts |

All defined in `tailwind.config.ts` with CSS custom properties for theming.

### Animations & Transitions

| Utility | Timing | Use Case |
|---------|--------|----------|
| `animate-pulse` | 2s ease-in-out | Skeleton loaders, gentle indicators |
| `transition-all` | Default (150ms) | Hover effects, subtle lift |
| `duration-200` | 200ms | Hover shadows, color shifts |
| `ease-in-out` | Ease curve | Smooth, natural feeling animations |

**Installation:**
```bash
# Already installed and configured in Phase 14-15:
pnpm install tailwindcss @tailwindcss/vite
pnpm dlx shadcn@latest init
# Core components already available: Button, Card, Input, Dialog, Badge, Select, Tabs, Checkbox, Label, Textarea, Popover
```

## Architecture Patterns

### Modern Kanban Board Pattern

**What:** Grid layout (5 columns) with card-based tasks, subtle styling, compact spacing, visual feedback on drag/drop

**Key patterns:**
1. **Column header:** Minimalist design with tight padding (12px), soft background, task count badge
2. **Drop zone:** Flex container with subtle transitions, background highlights on drag-over
3. **Task card:**
   - Compact padding (12px)
   - Subtle border (1px solid, border color from design system)
   - Soft shadow (0 1px 2px rgba), elevated on hover
   - 8px rounded corners (modern aesthetic)
   - Semantic colored status dot (5-7px circle, inline with title)
   - No full status labels (column position provides context per decisions)

**Example structure:**
```typescript
// KanbanBoard.tsx
<DndContext>
  <div className="grid grid-cols-5 gap-4 p-4 bg-background">
    {columns.map(col => (
      <KanbanColumn>
        <div className="rounded-lg border border-border bg-card shadow-sm">
          <header className="border-b px-3 py-2 bg-muted">
            {title} <span className="text-muted-foreground">({count})</span>
          </header>
          <div className="overflow-y-auto p-3 transition-colors">
            {tasks.map(task => (
              <div className="mb-3 rounded-md border border-border bg-card p-3 shadow-sm
                              hover:shadow-md hover:border-ring transition-all duration-200">
                {/* Task content with status dot */}
              </div>
            ))}
          </div>
        </div>
      </KanbanColumn>
    ))}
  </div>

  <DragOverlay>
    {activeTask && <div className="opacity-50">{/* dragging item */}</div>}
  </DragOverlay>
</DndContext>
```

### Status Dot Pattern

**What:** Small colored circle (5-7px) indicating task/agent status with optional animation

**Implementations:**
- **Static (idle):** Colored dot, no animation
- **Pulsing (active):** Use Tailwind `animate-pulse` or custom animation via `@keyframes`
- **Positioning:** Inline with title or top-right corner depending on space

**Example with Tailwind:**
```jsx
// Static status dot
<span className="inline-block w-2 h-2 rounded-full bg-success mr-2" />

// Pulsing status dot (running)
<span className="inline-block w-2 h-2 rounded-full bg-warning animate-pulse" />
```

**Custom keyframes (if needed):**
```css
@keyframes gentle-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
.animate-gentle-pulse { animation: gentle-pulse 1.5s ease-in-out infinite; }
```

### Hover Effects (Subtle Lift)

**What:** Shadow increase + color/border brightness shift on card hover

**Pattern:** Combine Tailwind utilities for snappy, responsive feedback

**Example:**
```jsx
<div className="rounded-lg border border-border bg-card shadow-sm
                hover:shadow-md hover:border-ring transition-all duration-200
                cursor-pointer">
  {/* content */}
</div>
```

**What happens:**
- Shadow: `shadow-sm` (0 1px 2px) → `shadow-md` (0 4px 6px) on hover
- Border: `border-border` → `border-ring` (accent color) on hover
- Duration: 200ms snappy transition (locked decision)
- No bold scale transforms (subtle, not distracting)

### Drop Zone Styling (dnd-kit)

**What:** Visual feedback when dragging over valid drop targets

**Pattern using dnd-kit + Tailwind:**

```jsx
// In KanbanColumn.tsx
const { setNodeRef, isOver } = useDroppable({ id: columnId });

return (
  <div
    ref={setNodeRef}
    className={cn(
      "rounded-lg border-2 border-transparent transition-all duration-150",
      isOver && "border-success bg-success/5" // colored border + light tint on drag-over
    )}
  >
    {/* drop zone content */}
  </div>
);
```

**Visual feedback layers:**
1. Border highlight: Success/warning/error color (semantic)
2. Background tint: 5% opacity of highlight color for subtle visibility
3. Ghost element: DragOverlay with 50% opacity for semi-transparent feedback

### Header Navigation Tab Pattern

**What:** Horizontal tab bar showing all pages (Kanban, Agent Monitor, Worktree Manager, Settings) with active indicator and status info

**Using Radix Tabs via shadcn/ui:**

```jsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export function AppHeader() {
  const [activePage, setActivePage] = useState("kanban");

  return (
    <header className="border-b bg-card shadow-sm">
      <div className="flex items-center justify-between p-3">
        {/* Left: Project name + global status */}
        <div className="flex items-center gap-4">
          <h1>{projectName}</h1>
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span>● {agentsRunning} agents</span>
            <span>● {worktreesCount} worktrees</span>
          </div>
        </div>

        {/* Center/Right: Page tabs */}
        <Tabs value={activePage} onValueChange={setActivePage}>
          <TabsList className="bg-muted">
            <TabsTrigger value="kanban" className="text-sm">
              Kanban
            </TabsTrigger>
            <TabsTrigger value="agents" className="text-sm">
              Agents
            </TabsTrigger>
            <TabsTrigger value="worktrees" className="text-sm">
              Worktrees
            </TabsTrigger>
            <TabsTrigger value="settings" className="text-sm">
              Settings
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Right: Action buttons */}
        <div className="flex gap-2">
          {/* buttons */}
        </div>
      </div>
    </header>
  );
}
```

**Active tab styling (per decisions):**
- Active trigger gets `bg-background` (different from inactive `bg-muted`)
- Text color shifts: `text-muted-foreground` → `text-foreground`
- Subtle shadow on active: `shadow` utility

### Component Spacing & Layout

**Container padding:** 12-16px (compact, modern feel)
**Card padding:** 12px (consistent)
**Gap between items:** 12-16px (tight, maximize visibility)
**Border radius:** 8px for modern aesthetic
**Shadows:** Soft/subtle (0 1px 2px for base, 0 4px 6px for hover)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|------------|-------------|-----|
| Status animations (pulse) | Custom CSS keyframes | `animate-pulse` from Tailwind or `@keyframes` + `animation` property | Consistent timing, proven performance, matches design system |
| Tab navigation | Custom button state management | `@radix-ui/react-tabs` (via shadcn/ui Tabs component) | Accessibility (ARIA), keyboard navigation, built-in active state management |
| Hover effects with transitions | Manual state + setTimeout | Tailwind `transition`, `duration`, `hover:` variants | Declarative, zero-runtime overhead, responsive to user preference (prefers-reduced-motion) |
| Drag feedback styling | Custom CSS positioning | dnd-kit DragOverlay + Tailwind classes | Proper event handling, smooth performance, no race conditions |
| Color system (semantic) | Hardcoded color values | CSS variables from Phase 15 (`var(--success)`, `var(--warning)`) | Centralized theming, dark mode support, system accent override capability |
| Component styling consistency | Individual CSS files per component | Tailwind utilities + shadcn components | Single source of truth, eliminates CSS specificity issues, easier maintenance |

**Key insight:** All visual refinements should compose from Tailwind utilities and the Phase 15 design token system. Custom CSS should be minimal (terminal styling, special cases only). This ensures consistency, maintainability, and fast iteration.

## Common Pitfalls

### Pitfall 1: Hover Effects That Fight Animations

**What goes wrong:** Adding `hover:scale-105` with `animate-pulse` creates janky, conflicting animations

**Why it happens:** Multiple transform properties compete; pulse opacity changes conflict with scale

**How to avoid:** Use only shadow/border/color shifts for hover (no scale/transform). Keep animations separate from hover states.

**Warning signs:** Jerky motion on hover, animation stutters when mouse over element, inconsistent feedback

**Prevention:**
```jsx
// ❌ BAD: scale conflicts with animations
<div className="animate-pulse hover:scale-105 transition-transform">

// ✅ GOOD: shadow/color shift only
<div className="hover:shadow-md hover:border-ring transition-all duration-200">
```

### Pitfall 2: Drag-Over Styling That Persists

**What goes wrong:** Drop zone keeps highlight color even after drag ends (CSS class remains applied)

**Why it happens:** DndContext doesn't auto-clean `isOver` state; need to check in render

**How to avoid:** Always bind drop zone classes to `isOver` boolean from `useDroppable` hook. Never hardcode `drag-over` class in HTML.

**Warning signs:** Highlighted drop zones don't unhighlight, visual state doesn't match real drop target state

**Prevention:**
```jsx
// ❌ BAD: static class
<div className="border-success bg-success/5"> {/* stays highlighted forever */}

// ✅ GOOD: dynamic binding
<div className={isOver ? "border-success bg-success/5" : "border-transparent"}>
```

### Pitfall 3: Transition Duration Mismatch

**What goes wrong:** Some effects animate at 150ms, others at 300ms → feels inconsistent

**Why it happens:** Mixing custom CSS animations with Tailwind durations without standardization

**How to avoid:** Standardize on `duration-200` (200ms) per locked decisions. Use Tailwind utility consistently across all transitions.

**Warning signs:** Some hovers feel snappy, others feel slow; perceived responsiveness varies

**Prevention:**
```jsx
// ❌ BAD: inconsistent timing
<div className="transition duration-300" />
<div className="hover:shadow-md" /> {/* uses default 150ms */}

// ✅ GOOD: consistent 200ms
<div className="transition-all duration-200" />
<div className="hover:shadow-md transition-all duration-200" />
```

### Pitfall 4: Color Tokens in Hardcoded Values

**What goes wrong:** Hardcoding `bg-green-500` instead of using semantic `bg-success` → theme changes break styling

**Why it happens:** Forgetting to use CSS variable system from Phase 15

**How to avoid:** Always use semantic color tokens (`success`, `warning`, `error`, `accent`, `muted`, etc.) defined in `tailwind.config.ts`. Never hardcode tailwind color names directly.

**Warning signs:** Colors don't change in dark mode; theme switch has no visual effect

**Prevention:**
```jsx
// ❌ BAD: hardcoded tailwind colors
<div className="bg-green-500 text-green-900">

// ✅ GOOD: semantic tokens
<div className="bg-success text-foreground">
```

### Pitfall 5: Missing Border/Shadow on Interactive Elements

**What goes wrong:** Cards look flat and unresponsive; users unsure what's clickable

**Why it happens:** Prioritizing minimalism over affordance; too much subtlety

**How to avoid:** Always include subtle base shadow (`shadow-sm`) + border on interactive cards. Hover adds shadow increase. Never remove all visual cues.

**Warning signs:** Users don't understand what's interactive; clicks feel unresponsive

**Prevention:**
```jsx
// ❌ BAD: completely flat
<div className="p-3 bg-background">

// ✅ GOOD: subtle depth + affordance
<div className="rounded-lg border border-border bg-card shadow-sm p-3 hover:shadow-md">
```

## Code Examples

### Example 1: Status Dot with Pulse Animation

**Source:** Tailwind CSS animation utilities + React inline styling

```jsx
// For running/active status
<div className="flex items-center gap-2">
  {/* Pulsing dot for active state */}
  <span className="inline-block h-2 w-2 rounded-full bg-warning animate-pulse" />
  <span className="text-sm font-medium">Running</span>
</div>

// For idle status (no animation)
<div className="flex items-center gap-2">
  <span className="inline-block h-2 w-2 rounded-full bg-muted" />
  <span className="text-sm font-medium text-muted-foreground">Idle</span>
</div>
```

### Example 2: Hover Effect with Shadow Lift

**Source:** Tailwind transition utilities + CSS variables

```jsx
<div className="rounded-lg border border-border bg-card shadow-sm p-3
                hover:shadow-md hover:border-ring
                transition-all duration-200
                cursor-pointer">
  <div className="font-semibold text-foreground">Task Title</div>
  <p className="text-xs text-muted-foreground mt-1">Task description</p>
</div>
```

### Example 3: Drop Zone Visual Feedback

**Source:** dnd-kit `useDroppable` + Tailwind conditional classes

```jsx
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';

export function DropZone({ id, children }) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-lg border-2 border-transparent transition-all duration-150 p-3",
        isOver && "border-success bg-success/5"
      )}
    >
      {children}
    </div>
  );
}
```

### Example 4: Page Tab Navigation

**Source:** shadcn/ui Tabs component + Tailwind styling

```jsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export function PageNavigation() {
  const [currentPage, setCurrentPage] = useState("kanban");

  return (
    <Tabs value={currentPage} onValueChange={setCurrentPage} className="w-full">
      <TabsList className="grid w-auto grid-cols-4 gap-1 bg-muted p-1">
        <TabsTrigger value="kanban" className="text-xs">
          Kanban Board
        </TabsTrigger>
        <TabsTrigger value="agents" className="text-xs">
          Agents
        </TabsTrigger>
        <TabsTrigger value="worktrees" className="text-xs">
          Worktrees
        </TabsTrigger>
        <TabsTrigger value="settings" className="text-xs">
          Settings
        </TabsTrigger>
      </TabsList>

      <TabsContent value="kanban" className="mt-4">
        <KanbanBoard />
      </TabsContent>
      <TabsContent value="agents" className="mt-4">
        <AgentMonitor />
      </TabsContent>
      {/* ... more tabs ... */}
    </Tabs>
  );
}
```

### Example 5: Compact Card Layout with Typography Hierarchy

**Source:** Tailwind spacing/sizing + Phase 15 typography scale

```jsx
<div className="rounded-lg border border-border bg-card p-3 shadow-sm hover:shadow-md transition-all duration-200">
  {/* Title: lg weight (0.875rem / 1.125rem) */}
  <h3 className="font-semibold text-foreground">Task Name</h3>

  {/* Subtitle/meta: sm (0.875rem) */}
  <p className="text-xs text-muted-foreground mt-1">Created 2 hours ago</p>

  {/* Status badge: xs (0.75rem) */}
  <div className="mt-2 inline-block rounded px-2 py-1 bg-warning/10 text-warning text-xs font-medium">
    In Progress
  </div>
</div>
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Global CSS file + BEM naming | Tailwind utilities + CSS variables | Phase 14 | Eliminated CSS conflicts, faster iteration, zero-runtime CSS bloat |
| Component-specific CSS modules | Tailwind + shadow DOM styles | Phase 15 | Consistent design tokens across all components, easier theming |
| Hardcoded color values | Semantic CSS variables (Phase 15) | Phase 15 | Dark mode support, system accent override capability (Phase 16) |
| Static hover states | Tailwind `hover:` variants + transitions | Phase 15 | Responsive effects that respect user preferences |
| Hand-rolled animations | Tailwind built-in animations (`animate-pulse`, etc.) | Phase 15-16 | Standardized timing, smaller bundle |
| Radix UI components with defaults | Customized Radix via shadcn/ui | Phase 15 | Full design system integration, consistent styling |

**Deprecated/outdated:**
- Custom CSS files for individual component styling: Replaced by Tailwind utilities (Phase 15)
- Bootstrap-style color classes (`bg-primary`, `text-danger`): Replaced by semantic tokens (`bg-success`, `text-error`) with CSS variables
- Manual state management for animations: Replaced by Tailwind's `transition` + `duration` variants

## Open Questions

1. **Exact pulse animation timing for status dots**
   - What we know: Locked decision requires "gentle pulse animation for active states"
   - What's unclear: Exact curve (ease-in-out vs ease) and cycle time (1.5s vs 2s)
   - Recommendation: Start with Tailwind default `animate-pulse` (2s ease-in-out), adjust if mockup shows different timing

2. **Specific icon library for worktree status**
   - What we know: Need checkmark for "clean" and dot for "dirty" git status
   - What's unclear: Which icon library (lucide-react, heroicons, simple SVG)
   - Recommendation: Claude's discretion area; use lucide-react (lightweight, ~350KB, widely used with shadcn) or simple inline SVG

3. **"Global status indicators" exact format in header**
   - What we know: Show "agents running count" and "worktrees count" alongside tabs
   - What's unclear: Visual format (badges, small text, icon indicators)
   - Recommendation: Simple small text: "● X agents running • Y worktrees" in muted foreground color

4. **Dark mode application**
   - What we know: Phase 15 set up dark theme CSS variables; Phase 16 applies redesign
   - What's unclear: Should all page redesigns have both light and dark variants tested, or dark-only in v1.1?
   - Recommendation: Dark mode already implemented (Phase 15); redesign works on both automatically via CSS variables

## Sources

### Primary (HIGH confidence)

- **Tailwind CSS v3** (`/websites/v3_tailwindcss`) — Animations, transitions, box-shadow, border-radius, spacing utilities, responsive design
- **dnd-kit** (`/websites/next_dndkit`) — DragOverlay customization, drop zone styling, visual feedback patterns
- **Codebase inspection** — Phase 15 design system implementation (CSS variables, color tokens, typography scale), existing shadcn/ui Tabs component

### Secondary (MEDIUM confidence)

- **shadcn/ui documentation** — Tabs component API, customization patterns (via Radix UI)
- **@radix-ui/react-tabs** — Accessibility features, keyboard navigation, active state management

### Tertiary (CONTEXT)

- **Phase 15 summaries** — Design system tokens established, typography configured, color system verified
- **Current codebase** — KanbanBoard.tsx, TaskCard.tsx, KanbanColumn.tsx show existing drag-drop patterns and styling structure
- **CLAUDE.md** — Project conventions: Tailwind first, CSS modules only for special cases, shadcn/ui for components

## Metadata

**Confidence breakdown:**
- **Standard stack:** HIGH — All libraries verified in Context7, versions match current codebase (Tailwind 4.1+, dnd-kit 8.x, shadcn/ui latest)
- **Architecture patterns:** HIGH — Patterns tested in current codebase (KanbanBoard, TaskCard already use dnd-kit; Phase 15 proved Tailwind approach)
- **Pitfalls:** MEDIUM-HIGH — Common patterns documented in Context7; some specific to GSD's codebase structure (CSS module transition strategy verified from Phase 15)
- **Animations:** HIGH — Tailwind animations verified in Context7; `animate-pulse`, `transition`, `duration` utilities confirmed standard
- **Tab navigation:** HIGH — Radix Tabs already integrated via shadcn/ui; styling patterns proven

**Research date:** 2026-02-10
**Valid until:** 2026-02-24 (14 days — Tailwind/dnd-kit stable, no major changes expected)

**Assumptions:**
- Phase 15 design system fully applied to codebase (CSS variables available, shadcn/ui components installed)
- dnd-kit remains primary drag-drop solution (confirmed in Phase 2, no migration planned)
- No new design system changes between Phase 15 and Phase 16 (incremental application only)
