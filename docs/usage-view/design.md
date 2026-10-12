# Usage view: approved design

The Usage view charts what agents cost and how many tokens they used, across every connection. It
is a screen of its own, reached from a tile on Home, and reads the per-turn usage each connection's
`maestro-server` records (see "Usage is recorded per turn" in `maestro-server/AGENTS.md`).

`mock.html` beside this file is the approved mock: a standalone copy of the canvas the design was
settled on, with every control working on made-up data. Where this document and the mock disagree,
the mock wins on visuals and this document wins on behaviour. The data model is this document's
alone; the mock's numbers are random.

Approved on 2026-10-12.

## What changed, and why

The home dashboard design (`docs/home-dashboard/design.md`) says Home shows real time only, since
nothing was tracked over time. Usage is now tracked, so that rule no longer holds for usage. Home
itself still shows real time only, apart from the one tile below; history lives in the Usage view.

## Home tile

A `pane` button in the hero, right of the scoreboard: `This week` in muted `11px`, then the cost
and the token total of the last 7 days, `$142.18 · 268M tokens ›`. It opens the Usage view. It reads
the app's local copy of the usage (see "Data"), so it shows what was last synced, and nothing when
nothing has been.

## Layout

One screen, the same glass recipes as Home (`docs/home-dashboard/design.md`, "Visual system").
Top to bottom:

1. `‹ Home`, back to Home.
2. **Title with the range.** `Usage over the last 7 days ▾` in `2xl` semibold, with `over the` in
   muted regular weight. The range part is the control: accent coloured, dotted underline. Under it
   in muted `text-xs`, the dates it covers (`Oct 5 – Oct 11, 2026`), nothing else.
3. **Filters.** `Filters:` then one removable chip per active filter, or a muted
   `none. Click a project or model below.`
4. **Two metric cards**, `Cost` and `Tokens`, side by side. Each shows the total for the range and,
   beside it, the average per bucket in the bucket's unit (`avg $20.31 / day`). The cards are also
   the metric switch: the selected one has the primary border and ring, the other sits at 75%
   opacity. Every chart, list and tooltip below shows the selected metric. There is no comparison
   with the previous period, and no other card.
5. **Main chart.** A switch, `Over time` or `Cumulative`, and on the right the split:
   `Connection`, `Model`, `Agent`, `Token type`. Legend under it.
   - _Over time_: stacked bars, one per bucket, coloured by the split, with a dashed line and a
     label at the average.
   - _Cumulative_: stacked areas, the running total from the start of the range, same split.
   - Hovering a bar or a point shows each series' value and the total for that bucket.
   - With Cost selected, `Model` and `Token type` are disabled, with the tooltip
     `Tokens only: cost is recorded per turn, not per model` (or `per token type`). If either was
     the split, it falls back to `Connection`.
6. **Heatmap**, its own panel, only when the range is 7 days or longer; hidden otherwise. Title
   `Cost by hour and weekday` (or `Tokens …`) followed by the dates in muted text. Seven rows
   (Mon to Sun) by 24 columns (hours, local time), each cell the selected metric summed over the
   range, on one sequential hue from faint to full, with a `less … more` legend. Hover shows the
   hour and the value.
7. **Projects** and **Models**, two panels side by side. Each row is two lines: the name, a muted
   qualifier (the project's connection, or the model's agent), the value, the share in percent and
   a chevron; then the bar on its own line. The chevron expands the row into tokens by type
   (Input, Output, Thought, Cache write, Cache read), tokens only. Clicking a row adds it as a
   filter.
   - _Projects_ shows the selected metric; the title says which, `Projects · cost`.
   - _Models_ always shows tokens, `Models · tokens`, and with Cost selected adds
     `cost is not recorded per model` in muted text. Model dots and bars use the model's colour
     from the Model split, so a model looks the same everywhere.
8. **Coverage line.** For each connection that is not attached: `gpu-rig not connected: showing its
usage up to Oct 9, 14:02 (cached). Connect to refresh.` A removed connection's usage stays,
   labelled `(removed)`, with no Connect link.

## Range control

Clicking the range opens a popover under it: presets on the left, two months of calendar on the
right (the existing shadcn `Calendar`, `mode="range"`, `numberOfMonths={2}`), `Cancel` and `Apply`
under the calendar.

- Presets: `Last hour`, `Last 24 hours`, `Last 7 days` (the default), `Last 30 days`,
  `Last 12 months`, `All time`. A preset applies at once and closes the popover.
- Picking a start and an end day selects `Custom`; `Apply` applies it and the title reads
  `Usage over the custom range`.

## Buckets

The bucket is how much time one bar covers, chosen from the range:

| Range          | One bar is | Bars                                 |
| -------------- | ---------- | ------------------------------------ |
| Last hour      | 1 minute   | 60                                   |
| Last 24 hours  | 1 hour     | 24                                   |
| Last 7 days    | 1 day      | 7                                    |
| Last 30 days   | 1 day      | 30                                   |
| Last 12 months | 1 month    | 12                                   |
| All time       | 1 month    | one per month since the first record |

A custom range: up to 3 days by hour, up to 90 days by day, longer by month. Days and months follow
the local clock. Usage older than 90 days exists as hourly totals only, so no bar back there is
finer than an hour.

## Colour

Series take the categorical palette in fixed order and keep their colour when filters change the
series count. The first slot, and the heatmap's one hue, is the user's accent colour; the other
slots are fixed. A connection that is not attached draws at reduced opacity. Text never takes a
series colour. Light and dark steps are in the mock.

## Data

### Where it is aggregated

The app keeps a **mirror** of every connection's usage in its own SQLite database, and every chart
is a local query over it. The daemons stay the source of truth; the mirror is what lets the view
add connections together, show a connection that is not attached, bucket by the local clock and
filter without a round trip.

### Syncing

- A connection syncs once when Home attaches to it, and then every 30 s while the Usage view is
  open. Nothing syncs in the background otherwise.
- A sync asks the daemon for the turns recorded after the last one the app has, by turn id, with
  their per-model rows. The first sync of a connection also takes the daemon's hourly totals, the
  history older than 90 days.
- The daemon answers with its **store id**, a random id kept in its `projects.db`. A store id the
  app has not seen means the daemon's database was recreated (a WSL distro or container rebuilt):
  the app keeps what it already has under the old id and starts syncing the new store from
  scratch, so history is not lost.
- When the app's last turn is older than what the daemon has since merged into hours (the app was
  away more than 90 days), the app drops that store's mirror and syncs it again from scratch. The
  app applies the daemon's retention rule to its own copy, so a fresh sync is the same data.

### Retention

The same rule as the daemon: turns older than 90 days are merged into hourly totals by UTC hour,
once a day, from the sync.

### One view over both

A SQL view unions the per-turn rows and the hourly totals into one shape (connection, time,
agent, project, model, tokens by type, cost), so every chart is one query against the view with a
time range, filters and a `GROUP BY`. A second view does the same for tokens per model.

### Rules

- **Cost** is per turn. A turn that reported no cost counts as zero, with no note.
- **A model is one name**, the one agents report per turn (`claude-opus-5-5`), without the
  context-window suffix (`[1m]`), across every agent that used it. A session's selected id
  (`opus`) stands for the reported model it spent the most tokens on, learned from the turns and
  hours that carry both.
- **Tokens per model** come from the per-model rows. A turn with none is credited to its selected
  id's model, with the turn's tokens. Filtering by a model keeps, for cost, the turns that used
  it.
- **Projects** are a connection and a path: the same path on two connections is two projects, each
  labelled with its connection. The name is the folder's.
- **Agents** are named from the agent registry, falling back to the raw `agent_id`.
- **Removed connections** keep their usage, labelled `(removed)`.
- **Currency** is assumed to be one currency (USD) throughout.

## Not in this design

Comparison with the previous period, cumulative-versus-previous charts, usage limits (they stay in
the session header), cost per model or per token type (not recorded), origin (task, automation or
chat), and a context-window chart.
