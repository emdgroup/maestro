# Home dashboard: approved design

The home dashboard replaces the project picker (`src/views/project-picker/`) as the screen Maestro
opens on. It is an informational board with navigation, not a control panel: almost everything on
it is a link, and the few controls that remain are the ones that belong to a connection (sign in,
add a project, the connection menu).

`mock.html` beside this file is the approved mock. Open it in a browser; every dialog, the inline
sign-in and the connection menu work. It is the reference for spacing, type sizes, colours and copy.
Where this document and the mock disagree, the mock wins on visuals and this document wins on
behaviour.

Approved on 2026-10-04. A first version put Integrations in a pill top-right and marked a "needs
you" tile with an amber left edge; both were rejected and replaced the same day by the Integrations
panel and the amber tint described below.

## What changed in the architecture, and why it shapes the design

Tasks, sessions, the task pipeline, automations and project locks all live in each connection's
`maestro-server` daemon now (see `maestro-server/AGENTS.md`). Work carries on with every window
closed. Three consequences drove the design:

- **There is no "open project" any more.** The board lists every project each connected daemon
  knows, with its live state, whether or not a window has it open.
- **Attention is the daemon's to report.** A blocked task, a pending permission or elicitation, a
  task waiting on its pull request (forge work still needs a window and the keychain token) and a
  task in Review are all readable from the daemon without opening the project.
- **The board shows real time only.** Nothing is tracked over time, so there are no sparklines,
  histories or "last activity" lines.

## Layout

One full-window screen, no app header bar.

1. **Background.** The picker's existing `screen-gradient` plus `AccentBubbles variant="screen"`,
   unchanged. Everything above it is glass, so the bubbles show through.
2. **Corner controls.** Floating top-right with no bar behind them, as on today's picker: accent
   colour, theme, settings, window controls. The strip doubles as the drag region.
3. **Hero**, one row, bottom-aligned (`flex items-end gap-12`):
   - left, the 3D logo `public/maestro-logo.png` at 64px with a soft drop shadow, then `Maestro` in
     `28px` semibold and under it, muted `text-xs`, `Conduct your agents in concert`;
   - right, a scoreboard of three numbers, `52px` semibold tabular, each with a muted `text-xs`
     label under it: `working` (`--accent`), `need you` (amber,
     `text-amber-600 dark:text-amber-400`), `to review` (purple, `--color-purple-500`, the Review column's colour). A zero fades to 40%.
   - No sentence. Earlier versions said `<N agents> at work. <M things> waiting on you.`; that was
     replaced by the scoreboard.
4. **A two-column row** above the connections (`grid grid-cols-2 gap-5`):
   - left, the glass **"Add a connection"** panel, styled like every other panel: `Add a connection`, `Where your project lives` under it, then the three type buttons (SSH host, WSL distro, Container) in a row;
   - right, the glass **Integrations** panel (see "Integrations panel" below), the same height.
5. **One glass panel per connection** in a two-column grid (`grid grid-cols-2 gap-5`). A connected
   panel spans both columns; a not-connected panel is one row tall and takes one column, so they
   pair up. Order: This computer, then every connection attached this session, then the ones not
   connected yet. A panel keeps its place while signing in (spanning both columns) and joins the
   attached group once attached.
6. **Version indicator** bottom-right (`v0.34.0`), opening the existing `UpdateCard` popover.

## Visual system

**Colour meaning.** Working is the user's accent colour (`--accent`), never green: green reads as
done. Review is purple-500, the Review column's colour on the board (`KanbanColumn.tsx`). Needs you
is amber. Green is kept for completed steps only (the check marks of a connecting checklist).

All values below are in `mock.html` as CSS classes of the same name.

| Class          | Use                                               | Recipe                                                                                                                                                                |
| -------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `glass`        | connection panels, dialogs                        | `card` at 42% over transparent, `backdrop-filter: blur(20px) saturate(150%)`, 1px border of `foreground` at 9%, inset top highlight of white at 20%, soft drop shadow |
| `glass-strong` | menus, confirmation dialogs                       | as `glass` with `card` at 72% and `blur(24px)`, so text over moving bubbles stays readable                                                                            |
| `pane`         | project tiles, choices inside dialogs             | `background` at 38% inside a glass panel, 1px border at 7%; hover lifts 2px and raises to 62%                                                                         |
| `pane.sel`     | the chosen option in a dialog                     | border and fill in `--accent`                                                                                                                                         |
| `pane.attn`    | a project tile that needs you                     | amber `#f59e0b` at 13% over `background` at 30%, border amber at 34%; hover raises them to 19% and 48%                                                                |
| `ghost`        | "Add project" tile                                | 1.5px dashed border of `foreground` at 18%; hover turns it `--accent` with an 8% fill                                                                                 |
| `pill`         | small glass buttons (Connect, Start, icon badges) | `card` at 50%, `blur(14px)`                                                                                                                                           |
| `field`        | inputs                                            | `background` at 55%, border at 12%, `--accent` border on focus                                                                                                        |
| `scrim`        | behind a dialog                                   | `background` at 30%, `blur(6px)`                                                                                                                                      |

Radii: connection panels and dialogs `22px`, tiles `rounded-2xl`, inputs and buttons `rounded-xl`.
Names use `letter-spacing: -0.025em`. Counts use tabular numerals. Motion is short: dialogs pop in
over 180 ms, menus drop in over 140 ms, a revealed body fades down over 250 ms, a refused sign-in
shakes once.

## Connection panel

**Header row:** a 36px glass icon tile (computer, server, terminal or container), the name in `text-lg`
semibold with the host underneath in `11px` muted, then on the right the status and the `⋯` button.

**Header note** (connected panels): muted `text-xs`, `<N> automation(s) running` while any run on
the connection, else nothing. Capacity and the next scheduled run were tried and dropped as too
long; there is no capacity gauge or slot count either, since it would not scale to dozens of agents.

**Rename** is not in the `⋯` menu. Hovering a panel fades in a small pencil button right after the
name (every connection but This computer, in every state). It turns the name into a `field` input
in place, text selected; Enter or leaving the field saves, Escape cancels, an empty name is ignored.

**Minimized panel.** Clicking a connected panel anywhere that is not a tile, button, input or menu
collapses it to two rows: the unchanged header, then one line of project chips. A chip is a
rounded-full `pane` with the project name and its status word in the status colour, tinted amber
(`pane.attn`) when it needs you, and opens the project like a tile does. Chips are ordered Needs
you, Working, Idle, Quiet, never wrap, and fade out at the right edge when they overflow. Clicking
the panel again expands it. Each connection remembers its state.

Status by state:

| State          | Right side of the header                       | Body                                                                                   |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Connected      | muted text, then `⋯` (see "Header note" below) | project tiles, then the "Add project" tile                                             |
| Not connected  | a `Connect` pill only, no status and no `⋯`    | none: the panel is the header row alone                                                |
| Signing in     | `Not connected`, muted                         | inline password form (below)                                                           |
| Connecting     | `Connecting…`                                  | three inline steps with spinner and check marks                                        |
| Server stopped | `Server stopped`, panel at 75% opacity         | `The Maestro server is stopped. Nothing runs here until it starts.` and a `Start` pill |
| Unreachable    | `Unreachable` in rose, panel at 75% opacity    | `Not answering. Its projects keep their state and come back when it does.`             |

**Project tile** (`pane`, min height 132px, grid `repeat(auto-fill, minmax(230px, 1fr))`):

- The project name, `17px` semibold. No colour dot, no activity dot.
- The path under it, monospace `11px`, in the connection's own separator (`~\src\x` on Windows,
  `~/src/x` elsewhere).
- A status word top-right, `11px`: **Working** (`--accent`, pulsing gently), **Needs you** (amber),
  **Idle** (muted, open tasks but no agent), **Quiet** (faint, nothing open).
- A tile that needs you is tinted amber all over (`pane.attn`). There is no edge or stripe.
- One context line: the blocking prompt in amber (`Permission to run a migration`), else a running
  automation (`nightly-lint running`), else `Open in this window`, else `Open on <holder>`.
- Three counts at the bottom: `working` in `--accent`, `review` in purple-500, `queued` in the
  foreground colour. A zero fades to half opacity.
- The whole tile is the link into the project. A tile held by another window runs the existing
  takeover flow when clicked; there is no separate button for it.

**"Add project" tile:** a `ghost` tile the same size as a project, a light `+` and `Add project`. It is
always the last tile of a connected panel.

## Integrations panel

`Integrations`, then a muted line: `<N> integrations across <S> services`, or `Issues and pull
requests, for every connection` when there are none. Then one row of 42px square tiles:

- **One tile per provider, not per account.** There can be several integrations of one provider
  (two GitHub accounts, a gitlab.com and a self-hosted GitLab), so a tile carries a count badge
  (foreground on background, top-right) when it holds more than one. The provider list is short and
  fixed (eight today), so the row cannot outgrow the panel.
- **Tiles use the `pane` look** of the Add a connection buttons, with the provider's `BrandIcon`.
- **A dashed `+` tile** always ends the row. With no integration it is the only tile.
- There is no `Manage` link: the tiles and `+` cover everything it did.

**Hovering a tile** opens a card under it (`pop-pane`: the `pane` colours made opaque, since the
glass panel it sits in is a backdrop root and its blur cannot reach the panels below). The card
lists the provider name, `<N> accounts`, its capability tags (`issues`, `pull requests`, `merge
requests`), one row per integration (icon, account, instance in monospace, a `gh cli` tag when
the gh CLI provides it, `›`), and last `+ Add another <provider> account`. An invisible strip
bridges the gap between tile and card, so the pointer can move onto it and click a row. The card is
shown by CSS, never by re-rendering, so hovering cannot flicker.

**Clicking a tile** pins its card open (accent border and a 2px accent ring on the tile) until a
click outside, Esc, or a second click on the tile. While one card is pinned, hovering another tile
opens nothing.

**An integration row** opens its details sheet: eyebrow the provider, title the account, the icon
and capability tags, `Account` and `Instance`, then `Disconnect` (rose, text) and `Edit
credentials`. One provided by the gh CLI says `Managed by the gh CLI. Sign out there to remove
it.` and has neither button. This is `IntegrationDetailModal` restyled.

**`+` and `Add another …`** open `Add an integration`: first `Choose a service`, a two-column grid
of the eight providers (icon, name, capability tags), then `Connect <provider>` with the fields
`IntegrationConnectDialog` asks for and its per-provider instructions, and `Connect`. `Add another
<provider> account` skips the first step; from the grid, a `‹` goes back to it.

## Dialogs

All dialogs are a `glass` sheet over the blurred `scrim`, closed by clicking outside or `✕`, with a
small uppercase eyebrow over a `2xl` title.

**Add a project** (eyebrow `On <connection>`): three large `pane` choices with an icon, a title and one
line, and the chosen one highlighted:

- **Open a folder** (`A repository already on this machine`): path field starting at the connection's
  usual source folder with its own separator, `Browse…` (the existing remote `FilePicker`), `Open`.
- **Clone** (`From GitHub or any git URL`): URL field, `Into` folder field, `Clone`.
- **Start fresh** (`A new, empty repository`): project name, `in` folder field, `Create`.

**Add a connection**, opened from one of three `pane` buttons in the dashed panel (SSH host, WSL
distro, Container; This computer always exists, so it is not offered):

- **SSH host:** `Address` (`user@host or user@host:port`, large monospace), optional `Name`, and a
  segmented `Sign in with` control (SSH agent, Key file, Password). Key file shows a path with
  `Browse…`; Password shows a field and `Remember in the system keychain`. Footer note: `Maestro
installs its server on the host the first time.`, then `Connect`. This folds today's separate
  `SshAuthModal` into the same step.
- **WSL distro:** the distributions on this PC with Running or Stopped; one already added is dimmed
  and says `already added`.
- **Container:** running containers with image (monospace) and uptime.
- Connecting turns the sheet into a checklist: `Reaching <host>`, `Installing the Maestro server`,
  `Starting it`, `Ready`, then closes and the new panel appears. This is the existing preflight and
  deploy, shown in place of `PreflightModal`.

## Connecting

Home attaches to This computer on its own and to nothing else. Every other connection starts at
a one-row panel with a `Connect` pill, however it signs in. `Connect` attaches straight away when no
prompt is needed (SSH agent, key file, saved password, WSL, container) and shows the inline
password form otherwise. Once attached, a connection stays attached until the app closes; there is
no Disconnect. The hero counts only attached connections.

**Inline sign-in** happens in the panel, not a dialog: a focused password field, `Sign in`, `Cancel`,
and under it `Remember in the system keychain` (ticked by default) and the hint `Or use a key: ⋯ ›
Change sign-in`. An empty submit shakes the row and says `Enter the password for <user@host>.` `Cancel`
returns the panel to its one-row state. A submit shows `Signing in`, `Reaching the Maestro server`,
`Reading projects` inline (a connection with no password shows `Reaching <name>` first), then the tiles
appear and the hero counts update.

## Connection menu (`⋯`)

A `glass-strong` popover anchored under the button, 256px wide. A header gives the name and one line
of state (`Maestro server 0.34.0 · up 3d 6h`, `Not connected` while signing in, `Server stopped`, `Last seen 2h ago`).
Items depend on state:

| Item                                         | Shown when           |
| -------------------------------------------- | -------------------- |
| Try again                                    | unreachable          |
| Start server                                 | server stopped       |
| Settings, hint `Agents, capacity, webhooks`  | always               |
| Change sign-in, hint with the current method | SSH, not mid-sign-in |
| Restart server                               | connected            |
| Stop server (rose)                           | connected            |
| Remove connection (rose)                     | not This computer    |

Stop, Restart and Remove confirm in a `glass-strong` dialog listing the consequences, computed from
the connection's live state:

- **Stop:** `N agents stop mid-task` (their tasks resume when the server is back), `Task pipelines
pause on every project here`, `N scheduled automations skip their runs` (a missed run is dropped,
  not caught up), `Other windows lose their projects` with the holders named. Note: `It starts again
the next time you open a project here.` Rose button `Stop server`.
- **Restart:** the agents line and `Everything resumes on its own`. Accent button `Restart`.
- **Remove:** the same list when connected, and the note `Projects and their boards stay on <host>.
Adding the connection again brings them back.` Rose button `Remove`.

## Navigation into a project

Clicking a tile opens the project. The in-project header gets a way back to this board; the
breadcrumb explored earlier (`Home / connection / project`) is the starting point, to be settled when
that header is designed. Switching to a project on another connection releases the lock held on the
previous one, so a window never holds projects it is not showing.

## Open items

None at the moment.

## Reusing what exists

| Board element                      | Existing code to reuse                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Background                         | `screen-gradient` (`src/index.css`), `AccentBubbles`                                                            |
| Corner controls, version indicator | `ProjectPicker.tsx` top strip and `VersionBadge`                                                                |
| SSH, WSL, container forms          | `SshFormPanel`, `WslPickerPanel`, `ContainerPickerPanel`, `ssh-auth-modal/`                                     |
| Connecting checklist               | `PreflightModal` and the deploy it drives                                                                       |
| Open folder, Clone, Start fresh    | `FilePicker`, `CloneProjectDialog`, `CreateProjectDialog`                                                       |
| Lock holder and takeover           | `ProjectList` lock badges, `ProjectTakeoverDialog`                                                              |
| Integrations                       | `integrations-tab/`: `BrandIcon`, `IntegrationConnectDialog`, `IntegrationDetailModal`, `PROVIDER_CAPABILITIES` |
