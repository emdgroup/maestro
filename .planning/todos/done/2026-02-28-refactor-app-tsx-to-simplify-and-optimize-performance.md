---
created: 2026-02-28T21:42
title: Refactor App.tsx to simplify and optimize performance
area: ui
files:
  - src/App.tsx
---

## Problem

The main App.tsx component (290 lines) handles multiple concerns that impact complexity and performance:

1. **Performance concerns:**
   - Application start time can be optimized
   - Multiple useEffect hooks running on mount
   - Settings loading blocks the entire app initialization
   - Recent projects query runs immediately even when not needed

2. **Complexity concerns:**
   - App.tsx handles: project selection flow, settings management, page routing, modal state, slide animations
   - Multiple pieces of local state (currentProject, appLoading, selectedTask, activePage, etc.)
   - Page action definitions mixed with routing logic
   - Project selection handler includes settings save logic

3. **Potential optimizations:**
   - Lazy load views that aren't immediately visible
   - Defer non-critical queries (recent projects) until needed
   - Consider code splitting for modals
   - Extract page routing logic to a separate component
   - Simplify initialization flow

## Solution

TBD - Analysis needed to determine:
- Which logic can be extracted to custom hooks
- What can be lazy loaded or code-split
- Whether recent projects query should be deferred
- If page routing logic can be simplified
- Potential for memoization opportunities
