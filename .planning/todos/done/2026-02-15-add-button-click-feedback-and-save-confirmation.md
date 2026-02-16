---
created: 2026-02-15T21:24
title: Add button click feedback and save confirmation
area: ui
files:
  - src/components/ui/button.tsx
  - src/pages/Settings.tsx
  - src/components/ui/toaster.tsx
---

## Problem

Multiple issues with visual feedback create an unsettling user experience:

1. **No button click feedback**: Buttons lack visual feedback when clicked (e.g., scale animation, ripple effect), making it unclear if the click registered, especially when there's no immediate follow-up event

2. **Missing save confirmation**: The Settings page "Save" button doesn't show a toast notification after saving, leaving users uncertain whether their changes were actually persisted

3. **Wrong success icon color**: Success toasts currently use a black and white checkmark instead of a green checkmark, which is the universal convention for success states

These issues reduce user confidence in the interface and violate common UX patterns for action feedback.

## Solution

1. **Button click feedback**: Add active state animations to the Button component
   - Consider `active:scale-95` or similar transform for tactile feedback
   - Could also implement a subtle ripple effect or background color transition
   - Should apply to all button variants globally

2. **Settings save toast**: Add toast notification in Settings page after successful save
   - Display success toast with message like "Settings saved successfully"
   - Consider error toast if save fails

3. **Success icon styling**: Update toast success variant to use green checkmark
   - Change checkmark icon color to green (likely `text-green-500` or similar)
   - Ensure it follows WCAG AA color contrast requirements
   - Could also use accent color if green doesn't fit the design system
