# Handoff — side-panel annotations (PR #202)

Branch `maestro/harsh-field-33`, rebased on `main` at v0.16.0 (`b1b1ab44`).
PR: https://github.com/emdgroup/maestro/pull/202 — CI was green on commit `c6ffe1bd`.

## What this is

Annotations in the session side panel. Comment on a diff line in the Review tab, or select text
in the Plan tab, then send the collected notes to the **running** session as one "please answer
these" prompt. Distinct from the Kanban review modal (`TaskReviewPanel`), whose feedback ends a
review instead of reaching the live agent.

## Decisions the user made (do not silently revisit)

- Diff annotating **reuses** `DiffViewer`'s existing review mode rather than getting its own UI.
- Plan annotating keeps the selected text highlighted and reopens **the same floating bubble**
  used to create it. No inline cards in the Plan tab.
- Counts and sends are **per tab** — Review's bar sends diff notes, Plan's sends plan notes.
- Annotatable plan surfaces: rendered plan markdown and the plan-permission overlay's body.
  The `planEntries` checklist stays read-only.
- Accent color, not amber, for every annotation surface.
- The Plan tab has a real top bar (an earlier floating overlay was rejected as unreadable).

## Layout

```
src/store/annotationStore.ts                   per-sessionKey, in memory, no persistence
src/components/execution/side-panel/annotations/
  AnnotationBar.tsx        "Send annotations | (#)" + bulk manage popover
  AnnotationComposer.tsx   plan composer: card frame, textarea inside, actions on the footer
  PlanAnnotationLayer.tsx  owns the plan pane's top bar, scroller, bubbles and highlights
  plan-anchor.ts           quote + occurrence <-> DOM Range (TreeWalker)
  plan-highlight.ts        CSS Custom Highlight API registry, unions all mounted layers
  build-annotation-prompt.ts
src/components/execution/diff/extend-data.ts   DiffView extendData mapping (see gotcha below)
```

Send path: `AgentActivityPanel.handleSendAnnotations` → `useMessageSender.handleSend("", blocks)`
→ `api.sendAcpPromptStructured`, then the sent ids are removed from the store.

## Things that will bite you

- **`extendData` must never be `undefined` in review mode.** `DiffView` applies it with
  `if (extendData) setExtendData(...)` (`@git-diff-view/react/dist/esm/index.mjs:1532`), so an
  undefined value skips the update and the last deleted comment's widget stays on screen with dead
  buttons. `buildExtendData` always returns a map; `extend-data.test.ts` pins that.
- **Plan highlights are rebuilt, never stored.** Ranges die on every react-markdown re-render, so
  `rangeForQuote` re-derives them from the quoted text on each paint. That is what makes the marks
  survive mid-stream streaming. Do not "optimize" by caching Range objects.
- **Highlights are not hit-testable.** Clicking one is a container click handler testing the point
  against `range.getClientRects()`.
- **The bubble stops click/mousedown/mouseup.** The container treats a click off a highlight as
  "dismiss", which otherwise unmounts the bubble before its own buttons can fire.
- **`PlanPermissionOverlay` listens on `window` for keys.** Its handler now ignores events from
  inputs/textareas/contenteditable; the layer's Escape/Enter listener is registered in the capture
  phase with `stopImmediatePropagation` so dismissing a bubble cannot answer the plan.
- **Sending is blocked mid-turn.** `handleSend` returns early when `isProcessing`, so the button is
  disabled and its click handler guards too (a base-ui `TooltipTrigger` still fires when disabled).

## State

Committed and CI-green: everything through the accent/positioning round.
Unpushed at the time of writing: the top-bar round — plan bar with hint text and prev/next
chevrons, pointer-anchored bubble, wider composer, `floating` prop removed from `AnnotationBar`.

Local checks for that round: `bun run lint`, `bun run format`, `bun run build`,
`bun run test --run` (417 pass). Rust untouched, so the Rust CI job is unaffected.

## Open items

1. **Not verified in the running app.** This worktree has no `src-tauri/target`, so no Tauri build
   was made here. The user has been testing each round by hand in a WSL project. The newest round
   (top bar, chevrons, composer) has had no visual pass at all.
2. **Worth a look:** the Plan bar in the plan-permission state. That pane already has a floating
   approve/reject bar at the bottom; the new bar at the top has not been seen together with it.
3. **Unrelated bug, untraced, reported by the user:** opening a terminal from a session's side
   panel in a **WSL project** fails with `Wsl/ERROR_FILE_NOT_FOUND`. Investigation stopped at:
   `AgentsView.spawnShell` → `useSpawnInteractiveExecutionMutation` →
   `src-tauri/src/execution/spawn.rs:spawn_interactive_execution`, which for WSL runs
   `wsl.exe -d <distro> --cd <worktree_abs_path>`. The lead being followed was that
   `Project::is_remote()` is `connection_id.is_some()` (SSH only), so a WSL project takes the
   `canonicalize_repo_path` branch on a **Linux** path from Windows — check what that produces
   before it reaches `--cd`. Reproduce, confirm, then fix; this is not part of PR #202.
