---
created: 2026-02-11T14:46
title: Improve kanban column design with pills and semantic colors
area: ui
files:
  - src/components/KanbanBoard.tsx
  - src/components/TaskCard.tsx
---

## Problem

The kanban board columns currently display task counts using parentheses (e.g., "Backlog (5)") and lack visual differentiation between columns. This creates several UX issues:

1. **Task count display:** Parentheses format looks dated and doesn't provide visual emphasis on the count
2. **Column differentiation:** All columns look identical without semantic color coding
3. **Visual hierarchy:** No quick visual cues to distinguish column status or priority
4. **Modern aesthetics:** Current design doesn't match modern kanban board patterns

Modern kanban boards typically use:
- Badge/pill components for counts (more visually prominent)
- Semantic color indicators (border, accent, or background) to distinguish columns
- Color psychology to communicate status (e.g., blue for in-progress, green for done)

## Solution

Enhance kanban column design with two key improvements:

### 1. Task Count as Pill/Badge

Replace parenthetical count "(5)" with a pill/badge component:

**Implementation:**
```tsx
<div className="flex items-center justify-between mb-3">
  <h3 className="text-sm font-medium">{columnTitle}</h3>
  <Badge variant="secondary" className="h-5 px-2 text-xs">
    {taskCount}
  </Badge>
</div>
```

**Styling options:**
- Use shadcn/ui Badge component with "secondary" variant
- Size: Compact `h-5 px-2 text-xs` for minimal visual weight
- Position: Right-aligned next to column title
- Color: Subtle background `bg-muted` with text `text-muted-foreground`

### 2. Semantic Color Indicators

Add color indicators to differentiate column status - requires research and design decisions.

**Research questions:**
1. **Where to apply color?**
   - Option A: Left border accent (4px colored border on column)
   - Option B: Header background tint (subtle colored background on column header)
   - Option C: Top border bar (thin colored bar above column)
   - Option D: Status dot indicator (small colored circle next to title)

2. **Color mapping for task statuses:**

   Research common conventions:
   - **Backlog:** Gray/Neutral (work not started, waiting)
   - **Ready:** Blue/Cyan (queued, ready to begin)
   - **InProgress:** Amber/Orange (active work, attention needed)
   - **Review:** Purple/Violet (under review, waiting for feedback)
   - **Done:** Green/Emerald (completed, success)

3. **Accessibility considerations:**
   - Ensure sufficient contrast ratios (WCAG AA)
   - Don't rely solely on color (combine with icons/labels)
   - Test in light and dark modes
   - Consider colorblind-friendly palette

**Proposed color palette (to be validated):**
```css
/* Using Tailwind color scale */
Backlog:    border-slate-400 (neutral)
Ready:      border-blue-500 (actionable)
InProgress: border-amber-500 (active)
Review:     border-purple-500 (waiting)
Done:       border-green-500 (complete)
```

**Implementation approach:**
```tsx
const getColumnColor = (status: TaskStatus) => {
  const colors = {
    Backlog: 'border-l-slate-400',
    Ready: 'border-l-blue-500',
    InProgress: 'border-l-amber-500',
    Review: 'border-l-purple-500',
    Done: 'border-l-green-500'
  }
  return colors[status]
}

// Apply to column container
<div className={`border-l-4 ${getColumnColor(status)} ...`}>
```

### 3. Additional Polish

- Add subtle hover effects on columns
- Ensure color indicators work with drag-drop feedback
- Test visual weight doesn't overwhelm content
- Document color choices in design system

**Next steps:**
1. Research existing kanban board designs (Trello, Linear, Jira) for color conventions
2. Create mockups/prototypes for different indicator approaches
3. Validate color choices for accessibility and brand consistency
4. Implement chosen design with proper CSS variables for theme support
