# Frontend (`src/`)

Notes for working in this directory. The repository-wide rules are in the root `AGENTS.md`. The daemon side of automations, the MCP tools and Collections is in
`maestro-server/AGENTS.md`.

## View Rendering

`App.tsx` renders the four main views (`KanbanView`, `AgentsView`, `WorktreesView`, `SettingsView`) as lazily-loaded modules using `React.lazy()`. Only the active view is visible; tab transitions animate using `framer-motion`'s `useAnimationControls`. `navigationStore` drives `activeTab` and `slideDirection`.

`KanbanView` renders either `<TaskDetailScreen>` (when `activeTaskId` is set) or the board + action bar. The `BoardView` inside renders all five columns and owns the `ReviewModal` and `ExecutionTerminal` drawer.

## Zustand Stores — Roles

| Store                  | Purpose                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boardStore`           | `activeTerminalTaskId` and `isTerminalOpen` — drives the bottom terminal drawer in `BoardView`                                                                |
| `navigationStore`      | Tab routing (`activeTab`), view-to-view slide direction, `activeTaskId` for task detail screen, `pendingAgentId`/`pendingWorktreeId` for deep-link navigation |
| `projectStore`         | Selected project reference; `useSelectedProject()` is the canonical way to get `projectId`/`projectPath`                                                      |
| `reviewStore`          | Diff data, selected file, and loading state for `ReviewModal`                                                                                                 |
| `sessionActivityStore` | Per-execution live status (`spawning` / `thinking` / `acting` / `awaiting`) shown in `AgentActivityPanel`                                                     |
| `configStore`          | App-wide settings (theme, model defaults) cached from Tauri                                                                                                   |

## Contexts

- `KanbanContext` — provides `projectId`, `projectPath`, `onTaskClick` to the kanban component subtree (avoids prop-drilling through `BoardView → KanbanColumn → TaskCard`)
- `ConnectionContext` — provides active `Connection` (local vs SSH vs WSL) and connection ID to the project picker subtree

## base-ui Component Pitfall

Tabs and Popover in `src/components/ui/` are from `@base-ui-components/react`, **not Radix UI**. The base-ui `Trigger` component has no `asChild` prop. To render a custom element as a trigger, use `buttonVariants()` directly on the element instead:

```tsx
// WRONG — asChild does not exist on base-ui Trigger
<PopoverTrigger asChild><Button>Open</Button></PopoverTrigger>

// CORRECT
<PopoverTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
  Open
</PopoverTrigger>
```

## Reading a cron expression, and reopening a run

`src/views/collections/automations/cron/` parses each field and decides nothing. `fields.ts` turns one
token into a value, and that one function is used three times: to colour a slot, to write that
field's clause in the sentence `describe.ts` builds, and to refuse `25` in an hour field before it
is saved. **When a schedule fires is never answered here.** `preview_schedule` asks the daemon,
which is the same `next_due` a stored automation's `next_due_at` comes from, so the editor and the
clock cannot disagree.

Two cron facts the UI has to carry, since nothing hides them any more. Sunday is 0 in a crontab and
1 in the crate the daemon schedules with, so the docs popover says so and the sentence uses day
names. And a restricted day of month **or**ed with a restricted day of week is what cron does:
`0 9 1 * 1` fires on the 1st and on every Monday, so `describe.ts` writes "or" and the test in
`cron.test.ts` pins it.

**A `runs` row carries what it takes to reopen a run**: `agent_session_id`, `agent_id`, `cwd` and
`can_reload`. `session_id` names a live session and stops resolving the moment the idle sweep
closes it, which is a minute or two after the run ends, so the run row is the only place those
survive. `can_reload` is recorded rather than asked because whether an agent answers `session/load`
cannot be discovered once its session is gone, and `DiscoveredAgent` does not carry it. A run
without it draws no button rather than one that fails.

**A finished run is read, not joined.** `runs.result` is the agent's last block of text, what it wrote
after its final tool call, followed per session by `helpers::note_session_update` and handed over
with the turn end, capped at 64 KB. Clicking a finished run opens `RunDialog` with that result (or the
failure reason), and Open session is only in there. A run still going carries Join, or Answer when
it waits on the user, instead.

**Needs input is a join, not a column.** A run is Running, Succeeded or Failed to the database;
whether it is blocked on a permission or an elicitation is live session state, and the panel
crosses the run's session id with `sessionActivityStore`. That also means the count is only as
fresh as the attachment: adoption replays pending requests, so it is right a second after the
window opens and not before.

## Canvas surfaces are HTML

A surface is an HTML document the agent writes, rendered in
`<iframe srcdoc sandbox="allow-scripts">` — opaque origin, no `allow-same-origin`, ever. That is
the whole trust boundary: `withGlobalTauri` puts `invoke` on the app origin with no per-command
permissions, so agent script on that origin could call all ~187 commands.

`src/components/execution/activity/canvas/canvas-frame.ts` builds everything Maestro prepends —
`<base href="about:blank">` (a srcdoc frame inherits the _parent's_ base URL, so without this
`<img src="logo.png">` fetches from the app's own origin), a frame-level CSP naming schemes and
never `'self'`, the theme tokens, the Tailwind browser build, and the bridge. None of it is saved
to disk; `canvas-file.ts` writes the agent's document alone.

**`script-src ... https:` in `tauri.conf.json` is load-bearing.** `about:srcdoc` inherits the app
CSP, so that line is what lets a canvas load a chart library from a CDN. Tightening it turns off
every canvas chart. The port-wildcarded localhost and `wss:` entries in `connect-src` are there so
a surface can read a live local endpoint.

Saved canvases are `.maestro/canvases/<acp_session_id>/<surfaceId>.html`, self-contained and
openable in a browser. `.json` files from before this change are left alone, not migrated.
