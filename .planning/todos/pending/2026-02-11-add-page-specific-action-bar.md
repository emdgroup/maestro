---
created: 2026-02-11T14:39
title: Add page-specific action bar under header
area: ui
files:
  - src/App.tsx
  - src/components/AppHeader.tsx
  - src/components/KanbanBoard.tsx
---

## Problem

The application lacks a consistent location for page-level actions. Currently, action buttons are scattered within page content or missing entirely, leading to:
- Inconsistent UX patterns across pages
- Difficulty discovering primary page actions
- No standard location for save/submit operations
- Missing integration points for external services (Jira, Github sync)

Modern applications typically include an action bar (toolbar) positioned directly below the main header, providing contextual actions for the current page. This creates a predictable location for primary page operations and improves discoverability.

## Solution

Create a page-specific ActionBar component that displays contextual actions below the AppHeader:

### 1. Component Architecture

**Create ActionBar component:**
```tsx
// src/components/ActionBar.tsx
interface ActionBarProps {
  actions: ActionBarAction[]
}

interface ActionBarAction {
  id: string
  label: string
  icon?: React.ComponentType
  variant?: 'default' | 'primary' | 'ghost'
  onClick: () => void
  visible?: boolean
  disabled?: boolean
}
```

**Layout:**
- Position: Fixed below AppHeader (total header height: h-12 + action bar height)
- Height: `h-12` for consistent sizing
- Background: Subtle background color with bottom border
- Styling: `border-b bg-muted/30` for visual separation

### 2. Page-Specific Actions

**Tasks Page:**
- Primary action: "+ Add Task" button (variant: primary)
- Conditional actions:
  - "Jira Sync" button (if `project.jira_config` exists)
  - "Github Sync" button (if `project.github_config` exists)
- Icons: `Plus`, `RefreshCw` (lucide-react)

**Agents Page:**
- "+ New Agent" button
- "Stop All" button (if any agents running)

**Worktrees Page:**
- "+ Create Worktree" button
- "Clean All" button (cleanup completed worktrees)

**Settings Page:**
- "Save" button (variant: primary, right-aligned)
- "Reset to Defaults" button (variant: ghost)

### 3. Implementation Pattern

**In App.tsx:**
```tsx
// Define actions based on activePage
const getPageActions = (): ActionBarAction[] => {
  switch (activePage) {
    case 'Tasks':
      return [
        {
          id: 'add-task',
          label: 'Add Task',
          icon: Plus,
          variant: 'primary',
          onClick: () => setShowTaskModal(true)
        },
        // Conditional sync buttons based on project config
      ]
    case 'Settings':
      return [
        {
          id: 'save',
          label: 'Save',
          variant: 'primary',
          onClick: handleSaveSettings
        }
      ]
    // ... other pages
    default:
      return []
  }
}

return (
  <div>
    <AppHeader {...props} />
    <ActionBar actions={getPageActions()} />
    <main className="pt-24"> {/* Adjust for header + action bar */}
      {/* Page content */}
    </main>
  </div>
)
```

### 4. Visual Design

- Left-aligned buttons by default
- Right-aligned save/submit buttons on forms
- Primary action uses accent color
- Secondary actions use ghost variant
- Icons from lucide-react for consistency
- Spacing: `gap-2` between buttons, `px-4` horizontal padding

### 5. Responsive Considerations

- Hide less important actions on mobile (< 768px)
- Show icon-only buttons with tooltips on small screens
- Ensure primary action always visible

### 6. State Management

- Actions defined at page level (in App.tsx or page components)
- Callbacks handle business logic (opening modals, saving data, triggering syncs)
- Visibility/disabled states computed from application state

This pattern creates a consistent, discoverable location for primary page actions while maintaining flexibility for page-specific requirements.
