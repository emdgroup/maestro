---
created: 2026-02-15T02:37
title: Fix project picker card height and scrollbar styling
area: ui
files:
  - src/components/ProjectPicker.tsx
  - src/components/RemoteProjectsList.tsx
  - src/components/ConnectionList.tsx
  - src/index.css
---

## Problem

The project picker screen has two layout and styling issues:

### 1. Inconsistent Card Height Growth

The picker card should dynamically grow in height based on the number of items in the displayed list, up to a maximum height. However, the behavior is inconsistent:

- **Connections list**: Card height grows properly as more connection items are added
- **Recent projects list**: Card height does NOT grow with the list - it maintains the height from the connections view even when switching to recent projects

This creates a poor user experience where the recent projects list may have excessive whitespace or be unnecessarily constrained, depending on the number of items.

**Expected behavior**: The card should adapt its height to fit the current list content (connections or recent projects), respecting the same max-height constraint for both views.

### 2. Inconsistent Scrollbar Styling

Scrollbars throughout the application (or at least in the project picker) have inconsistent styling. Some scrollbars use default browser styling while others may be themed.

**Expected behavior**: All scrollbars should use consistent, theme-aware styling that matches the application's design system (light/dark mode support, consistent width, colors matching the theme).

## Solution

**Card Height Issue:**
1. Identify why the card height is fixed when showing recent projects
2. Ensure the container uses dynamic height constraints (e.g., `min-h-[...]` and `max-h-[...]` in Tailwind)
3. Verify both ConnectionList and RemoteProjectsList have consistent height behavior
4. Test with varying numbers of items (0, 1, 5, 20+ items) in both lists

**Scrollbar Styling:**
1. Define theme-aware scrollbar styles in `src/index.css` using CSS custom properties
2. Apply scrollbar styling globally or to specific containers in the picker
3. Use Tailwind's scrollbar utilities or custom CSS for:
   - Scrollbar width
   - Track color (background)
   - Thumb color (foreground)
   - Hover states
4. Ensure styles work in both light and dark themes
5. Consider browser compatibility (webkit-scrollbar for Chrome/Safari, scrollbar-color for Firefox)

Example approach:
```css
.custom-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: hsl(var(--muted-foreground)) transparent;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 8px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: hsl(var(--muted-foreground));
  border-radius: 4px;
}
```
