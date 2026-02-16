---
created: 2026-02-14T12:57
title: Fix toast notifications in project picker
area: ui
files:
  - src/App.tsx:221
  - src/components/ProjectPickerNew.tsx:288
  - src/components/ErrorToast.tsx:13-21
---

## Problem

Toast notifications are not working in the ProjectPicker view because the `ToasterRoot` component is only rendered inside the main app view (after a project is selected), not in the project selection screen.

**Current behavior:**
- `ToasterRoot` is rendered at `src/App.tsx:221` inside the conditional block that requires `currentProject` to be truthy
- `ProjectPickerNew` component calls `toast.success()` and `toast.error()` (e.g., line 288 for "Project removed from recent list")
- These toast calls fail silently because there's no `<Toaster>` component mounted in the DOM

**Evidence:**
```tsx
// App.tsx:220-221
) : (
  <div className="app flex flex-col h-screen bg-background">
    <ToasterRoot />  // Only rendered AFTER project selection
```

```tsx
// ProjectPickerNew.tsx:288
toast.success("Project removed from recent list");  // Won't display
```

**Impact:**
- Users don't see feedback when removing recent projects
- Connection errors, authentication failures, and other notifications are invisible
- Poor UX in the project picker flow

## Solution

Move `ToasterRoot` to the top level of the App component so it's always rendered, regardless of whether a project is selected.

**Option 1 (Recommended):** Render ToasterRoot at root level
```tsx
// App.tsx
return (
  <ThemeProvider>
    <ToasterRoot />  // Move here - always rendered
    {loading ? (
      // ... loading state
    ) : !currentProject ? (
      <ProjectPickerNew ... />
    ) : (
      <div className="app ...">
        {/* Remove ToasterRoot from here */}
```

**Option 2:** Render ToasterRoot in both branches
- Keep it in main app view
- Add it to ProjectPickerNew view as well
- Less ideal (duplicates component, could cause multiple toasters)

**Testing:**
After fix, verify toasts work:
1. Open app without project selected
2. Try to remove a recent project → should see success toast
3. Try connecting to invalid SSH → should see error toast
4. Enter main app → toasts should still work
