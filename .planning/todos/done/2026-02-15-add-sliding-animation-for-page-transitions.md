---
created: 2026-02-15T08:30
title: Add sliding animation for page transitions
area: ui
files:
  - src/App.tsx:231-262
  - src/components/AppHeader.tsx:82-135
---

## Problem

The app currently has instant page transitions when switching between main pages (Tasks, Agents, Worktrees, Settings). This creates a jarring user experience that feels abrupt and lacks visual continuity. Modern applications typically use smooth transitions to help users understand spatial relationships between views.

Both the main content area below the AppHeader and the active tab indicator in the AppHeader itself should have synchronized sliding animations when navigating between pages.

## Solution

Implement sliding animations for page transitions:

1. **Content Area Animation:**
   - Add CSS transitions or Framer Motion to the main content area (App.tsx:232-262)
   - Slide direction should follow navigation order (Tasks → Agents → Worktrees → Settings)
   - Consider using `transform: translateX()` for better performance
   - Exit animation: slide out to left/right
   - Enter animation: slide in from right/left

2. **Tab Indicator Animation:**
   - Add animated underline or background transition in AppHeader tabs
   - Should smoothly move between active tab positions
   - Can use CSS `transition` on the active tab indicator
   - Consider using a sliding underline bar that animates its position

3. **Implementation Approach:**
   - Option A: Framer Motion's `AnimatePresence` and `motion` components
   - Option B: React Transition Group with CSS transitions
   - Option C: Pure CSS with view state classes
   - Ensure animations respect `prefers-reduced-motion` media query

Duration: Keep animations short (200-300ms) for responsiveness.
Easing: Use ease-in-out for natural feel.
