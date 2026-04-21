---
phase: quick-260410-amc
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/components/project-picker/ProjectPicker.tsx
autonomous: true
requirements: [QUICK-260410-amc]

must_haves:
  truths:
    - "Logo is visible on the project picker / connection screen"
    - "Logo is sized appropriately (not oversized, not tiny) relative to the heading"
    - "Logo and heading form a cohesive brand identity block"
    - "Layout remains centered and balanced on all viewport sizes"
  artifacts:
    - path: "src/components/project-picker/ProjectPicker.tsx"
      provides: "Logo image element above the Maestro heading"
      contains: "maestro-logo.png"
  key_links:
    - from: "src/components/project-picker/ProjectPicker.tsx"
      to: "public/maestro-logo.png"
      via: "img src attribute referencing /maestro-logo.png"
      pattern: "maestro-logo"
---

<objective>
Add the Maestro logo (public/maestro-logo.png) to the project picker / connection selection screen as a brand identity element above the app name.

Purpose: Give the startup screen visual identity using the mascot logo (red octopus conductor).
Output: Updated ProjectPicker.tsx with logo rendered above the "Maestro" heading.
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/components/project-picker/ProjectPicker.tsx
@src/App.tsx (renders ProjectPickerView when no project selected)
@public/maestro-logo.png (741x755 PNG, red octopus conductor mascot)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add logo to ProjectPicker brand block</name>
  <files>src/components/project-picker/ProjectPicker.tsx</files>
  <action>
In ProjectPicker.tsx, add an img element inside the existing `div.text-center.mb-8` block, positioned above the h1 "Maestro" heading.

Specific changes to the brand block (lines 17-20 of current file):

1. Add an img element as the first child of the text-center div:
   - src="/maestro-logo.png" (Vite serves files from public/ at root)
   - alt="Maestro logo"
   - Size: w-20 h-20 (80px) — the logo is nearly square (741x755) so this works well; large enough to be recognizable, small enough to not dominate the card below
   - mx-auto to center the image
   - mb-4 for spacing between logo and h1

2. The resulting brand block should look like:
   ```
   <div className="text-center mb-8">
     <img
       src="/maestro-logo.png"
       alt="Maestro logo"
       className="w-20 h-20 mx-auto mb-4"
     />
     <h1 className="text-3xl font-semibold mb-3">Maestro</h1>
     <h3 className="text-base text-muted-foreground">An agent orchestrator tool.</h3>
   </div>
   ```

Do NOT add the logo to AppHeader or any other component — only the project picker startup screen. Do NOT add drop-shadow, animation, or rounded classes; keep it clean and simple.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm build 2>&1 | tail -5</automated>
  </verify>
  <done>
    - Logo img element renders above the "Maestro" h1 in ProjectPicker.tsx
    - Image references /maestro-logo.png with alt text
    - Sized at w-20 h-20, centered with mx-auto, mb-4 spacing
    - Build passes with zero TypeScript errors
  </done>
</task>

</tasks>

<verification>
- `pnpm build` succeeds (TypeScript compilation + Vite bundle)
- ProjectPicker.tsx contains img element with src="/maestro-logo.png"
- No other files modified
</verification>

<success_criteria>
The project picker startup screen displays the Maestro octopus logo centered above the app name, creating a polished brand identity block. The logo is appropriately sized (80x80px) and the layout remains visually balanced.
</success_criteria>

<output>
After completion, create `.planning/quick/260410-amc-integrate-public-maestro-logo-png-gracef/260410-amc-SUMMARY.md`
</output>
