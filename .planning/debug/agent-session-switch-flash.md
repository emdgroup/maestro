---
status: awaiting_human_verify
trigger: "Switching between agent sessions causes a visual resize/flash. A previous fix using CSS visibility: hidden / visible was attempted but did not resolve it."
created: 2026-04-08T00:00:00Z
updated: 2026-04-08T00:01:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED — fit() was a no-op when called synchronously after terminal.open() because xterm's renderer had not yet computed cell dimensions (css.cell.width/height = 0). The visibility:hidden trick made this worse by ensuring the renderer could not paint, guaranteeing fit() failed. Terminal then appeared at 80×24 default. ResizeObserver fired on next frame, fit() succeeded, terminal resized to correct size = visible flash.
test: read FitAddon source — proposeDimensions() has guard: if (0 === e.css.cell.width || 0 === e.css.cell.height) return; — confirms synchronous fit() after open() is always a no-op
expecting: rAF-deferred fit() fires before browser paints, at which point cell dimensions are available, terminal sized correctly on first paint
next_action: await human verification

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Smooth, flash-free transition when switching between agent sessions in the Agents view
actual: A visible resize/flash occurs each time the user switches to a different agent session
errors: None reported — purely visual
reproduction: Open Agents view with multiple agent sessions, switch between them
started: Fix was previously attempted (visibility hidden/visible approach), regression persists

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: CSS visibility approach would prevent resize flash
  evidence: Was attempted and did not resolve the issue. Root cause explains why: visibility:hidden prevents the xterm renderer from painting, which is exactly what makes fit() a no-op (cell sizes never computed). The approach made the bug worse, not better.
  timestamp: 2026-04-08T00:00:00Z

- hypothesis: ResizeObserver's first callback causes the flash
  evidence: Partially correct — ResizeObserver does cause the second fit() call that resizes from 80×24 to actual. But the real root is that the first fit() was a no-op, not that ResizeObserver fires.
  timestamp: 2026-04-08T00:01:00Z

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-04-08T00:00:30Z
  checked: AgentMonitor.tsx line 194 — TerminalComponent key prop
  found: key={terminalSessionId} — forces full unmount/remount on every session switch, triggering the full mount sequence each time
  implication: Every session switch runs the entire useEffect from scratch, including open() and fit()

- timestamp: 2026-04-08T00:00:40Z
  checked: Terminal.tsx useEffect — sequence of open(), fit(), visibility
  found: terminal.open() → visibility=hidden → fit() called synchronously → visibility=visible → ResizeObserver registered
  implication: fit() runs while xterm renderer has not yet painted — cell dimensions are 0, fit() is a no-op

- timestamp: 2026-04-08T00:00:50Z
  checked: FitAddon source (node_modules/@xterm/addon-fit/lib/addon-fit.js)
  found: proposeDimensions() contains guard: if (0 === e.css.cell.width || 0 === e.css.cell.height) return; — fit() returns undefined if cell sizes not computed
  implication: Synchronous fit() after open() is always a no-op. Terminal stays at 80×24 default.

- timestamp: 2026-04-08T00:00:55Z
  checked: FitAddon fit() return path
  found: fit() only calls terminal.resize() if rows or cols actually changed — it is a no-op when proposed dimensions equal current dimensions
  implication: After rAF fit() sets correct dimensions, subsequent ResizeObserver fires will be no-ops (same size) — no ongoing flash risk

- timestamp: 2026-04-08T00:01:00Z
  checked: pnpm build output
  found: Build succeeded with no TypeScript errors in 2.74s
  implication: Fix is type-safe

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: FitAddon.fit() is a no-op when called synchronously after terminal.open() because xterm's internal renderer has not yet computed cell dimensions (css.cell.width/height = 0 until first browser paint). The visibility:hidden approach compounded this by ensuring the renderer could not paint at all. Terminal mounted at 80×24 default, then ResizeObserver fired (first async callback after observe()), fit() succeeded at that point (cell sizes now available), and the terminal resized from 80×24 to actual container size — causing the visible flash.

fix: Remove visibility:hidden/visible trick from both TerminalComponent and DeadSessionTerminal. Replace synchronous fitAddon.fit() with requestAnimationFrame(() => fitAddon.fit()). rAF fires before the next browser paint but after the renderer has set up cell dimensions, so fit() runs with correct cell sizes before the user sees anything. cancelAnimationFrame() added to cleanup to prevent fit() running after unmount.

verification: pnpm build succeeds, no TypeScript errors
files_changed:
  - src/components/execution/Terminal.tsx
  - src/components/execution/DeadSessionTerminal.tsx
