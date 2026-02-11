---
created: 2026-02-11T14:33
title: Add lucide-react icons to settings sections
area: ui
files:
  - src/components/ProjectSettingsModal.tsx
---

## Problem

The Settings page (currently ProjectSettingsModal.tsx, to be converted to SettingsPage.tsx per todo #4) lacks visual icons for its different sections. Adding icons improves:
- Visual hierarchy and scannability
- Modern app aesthetics
- Section identification at a glance
- Consistency with other UI elements (AppHeader uses lucide-react icons from Phase 17.1-02)

Modern settings pages typically use icons next to section titles to create visual anchors and improve UX. The app already uses lucide-react icons in AppHeader (LayoutDashboard, Users, GitBranch, Settings icons), so extending this pattern to the Settings page sections maintains consistency.

## Solution

Add lucide-react icons to each Settings section:

1. **Import relevant icons from lucide-react:**
   ```tsx
   import {
     Palette,      // Theme settings
     FolderOpen,   // Project info/path
     Settings,     // General settings
     // Add others as needed
   } from 'lucide-react'
   ```

2. **Suggested icon mapping for common settings sections:**
   - **Theme/Appearance:** `Palette`, `Sun`, `Moon`, or `Monitor`
   - **Project Info:** `FolderOpen`, `Folder`, or `Archive`
   - **General Settings:** `Settings`, `Sliders`, or `Cog`
   - **Preferences:** `User`, `UserCircle`, or `CheckSquare`
   - **Advanced:** `Code`, `Terminal`, or `Wrench`

3. **Layout pattern:**
   ```tsx
   <div className="space-y-6">
     {/* Section with icon */}
     <div>
       <div className="flex items-center gap-2 mb-3">
         <Palette className="w-5 h-5 text-muted-foreground" />
         <h3 className="text-sm font-medium">Theme</h3>
       </div>
       <div className="pl-7">
         {/* Section content */}
       </div>
     </div>
   </div>
   ```

4. **Styling considerations:**
   - Icon size: `w-5 h-5` or `w-4 h-4` for compact appearance
   - Color: `text-muted-foreground` for subtle visual weight
   - Spacing: `gap-2` between icon and section title
   - Indentation: `pl-7` for section content to align with title text

5. **Verify consistency:**
   - Check that icons match the semantic meaning of each section
   - Ensure icons render correctly in both light and dark modes
   - Maintain consistent icon size and spacing across all sections

This enhancement should be implemented after todo #4 (converting ProjectSettingsModal to SettingsPage) is complete, as the page structure may change during that refactor.
