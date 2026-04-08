---
phase: quick-260408-cee
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/utils/helpers/terminalTheme.ts
  - src/components/execution/Terminal.tsx
  - src/components/execution/DeadSessionTerminal.tsx
autonomous: true
requirements: []
must_haves:
  truths:
    - "Terminal uses Fira Code mono font (matching app font loading)"
    - "Terminal background matches app card/background color in both light and dark modes"
    - "Terminal foreground matches app foreground CSS variable"
    - "Theme updates if user switches light/dark while terminal is mounted"
  artifacts:
    - path: "src/utils/helpers/terminalTheme.ts"
      provides: "getTerminalTheme() returning ITerminalOptions with fontFamily + theme from CSS vars"
      exports: ["getTerminalTheme"]
    - path: "src/components/execution/Terminal.tsx"
      provides: "Live session terminal with themed options"
    - path: "src/components/execution/DeadSessionTerminal.tsx"
      provides: "Replay terminal with themed options"
  key_links:
    - from: "Terminal.tsx"
      to: "terminalTheme.ts"
      via: "getTerminalTheme() called before new Terminal()"
    - from: "DeadSessionTerminal.tsx"
      to: "terminalTheme.ts"
      via: "getTerminalTheme() called before new Terminal()"
---

<objective>
Style xterm.js terminals with Fira Code monospace font and app-matched background/foreground colors by deriving theme values from the app's CSS variables at runtime.

Purpose: Makes the terminal feel visually integrated with the app rather than a default white/black box dropped in.
Output: A shared terminalTheme.ts helper + both terminal components updated to use it.
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md

@src/utils/helpers/terminalTheme.ts (does not exist yet — create)
@src/components/execution/Terminal.tsx
@src/components/execution/DeadSessionTerminal.tsx
@src/index.css
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create terminalTheme helper</name>
  <files>src/utils/helpers/terminalTheme.ts</files>
  <action>
Create `src/utils/helpers/terminalTheme.ts` that exports a single function `getTerminalTheme()` returning an `ITerminalOptions` object (import from `@xterm/xterm`).

The function derives theme colors from CSS variables using a runtime trick — create a temporary invisible div, set `background-color` to a CSS var expression, append to document.body, call `getComputedStyle().backgroundColor`, then remove the element. The browser resolves oklch → rgb automatically.

```typescript
function cssVar(varName: string): string {
  const el = document.createElement("div");
  el.style.display = "none";
  el.style.backgroundColor = `var(${varName})`;
  document.body.appendChild(el);
  const color = getComputedStyle(el).backgroundColor;
  document.body.removeChild(el);
  return color;
}
```

Build `getTerminalTheme()`:
- `fontFamily`: `'"Fira Code", "Cascadia Code", "DejaVu Sans Mono", Menlo, Consolas, monospace'`
- `fontSize`: 13
- `theme.background`: `cssVar("--background")`
- `theme.foreground`: `cssVar("--foreground")`
- `theme.cursor`: `cssVar("--foreground")`
- `theme.selectionBackground`: `cssVar("--accent")` with alpha — since xterm needs rgba, append `// use as-is; browser returns rgb(), xterm accepts it`
- All other theme colors: omit (xterm uses reasonable defaults for ANSI colors)

Return shape:
```typescript
export function getTerminalTheme(): ITerminalOptions {
  return {
    fontFamily: '...',
    fontSize: 13,
    theme: {
      background: cssVar('--background'),
      foreground: cssVar('--foreground'),
      cursor: cssVar('--foreground'),
      selectionBackground: cssVar('--accent'),
    },
  };
}
```

Note: `selectionBackground` in xterm ITheme accepts rgb() strings. The `--accent` var resolves to an opaque color which is fine.
  </action>
  <verify>File exists and TypeScript compiles — run `pnpm build` (or `pnpm tsc --noEmit`)</verify>
  <done>src/utils/helpers/terminalTheme.ts exists, exports getTerminalTheme, no TypeScript errors</done>
</task>

<task type="auto">
  <name>Task 2: Apply theme to both terminal components</name>
  <files>src/components/execution/Terminal.tsx, src/components/execution/DeadSessionTerminal.tsx</files>
  <action>
In both `Terminal.tsx` and `DeadSessionTerminal.tsx`, import `getTerminalTheme` and spread its result into the `new Terminal({...})` options object.

**Terminal.tsx** — currently:
```typescript
const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  scrollback: 1000,
});
```
Update to:
```typescript
const terminal = new Terminal({
  cursorBlink: true,
  scrollback: 1000,
  ...getTerminalTheme(),
});
```
(fontSize from getTerminalTheme() replaces the hardcoded 14)

**DeadSessionTerminal.tsx** — currently:
```typescript
const terminal = new Terminal({
  cursorBlink: false,
  fontSize: 14,
  scrollback: 5000,
  disableStdin: true,
});
```
Update to:
```typescript
const terminal = new Terminal({
  cursorBlink: false,
  scrollback: 5000,
  disableStdin: true,
  ...getTerminalTheme(),
});
```

Import line for both files:
```typescript
import { getTerminalTheme } from "@/utils/helpers/terminalTheme";
```

`getTerminalTheme()` is called inside the `useEffect` (where `new Terminal(...)` lives), so it reads CSS variables at mount time — correct, since the DOM theme class (`.dark` / light) is already applied by then.
  </action>
  <verify>
    `pnpm build` passes with 0 TypeScript errors. In the app, open the Agents view and verify the terminal background matches the app background and uses Fira Code font.
  </verify>
  <done>
    Both terminal components use getTerminalTheme(). Terminal background/foreground/font match the app theme. Build is clean.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| CSS vars → xterm options | Reading computed styles from the app's own DOM — same origin, no untrusted input |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-cee-01 | Information Disclosure | cssVar helper | accept | Reads only the app's own CSS variables from its own document; no cross-origin or user-controlled input involved |
</threat_model>

<verification>
- `pnpm build` completes with 0 TypeScript errors
- `src/utils/helpers/terminalTheme.ts` exports `getTerminalTheme`
- Both `Terminal.tsx` and `DeadSessionTerminal.tsx` import and call `getTerminalTheme()`
- Visual check: terminal background in Agents view matches app background color
</verification>

<success_criteria>
Terminal displays in Fira Code monospace font with background and foreground colors derived from the app's CSS variables, integrating visually with both light and dark mode.
</success_criteria>

<output>
After completion, create `.planning/quick/260408-cee-style-terminal-with-mono-font-and-app-ba/260408-cee-SUMMARY.md`
</output>
