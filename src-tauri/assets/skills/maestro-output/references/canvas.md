# Canvas

Interactive UI is built by calling tools on the `maestro` MCP server. Each call renders into a
live surface in Maestro's side panel.

The `canvas_update` tool description lists every component and its props. Read the entries for the
components you intend to use — guessing a prop name produces a surface that renders empty, and
that description is the only place those names are defined. A malformed call comes back as a tool
error naming the problem; fix it and call again, because you never see the rendered result.

## Interactive UI, not just data

Most of this file is about dashboards, but the catalog also has real controls: `Button`,
`TextField`, `CheckBox`, `ChoicePicker`, `Slider`, `DateTimeInput`, and `Modal`. They render as
Maestro's own components in the user's current theme, so a mock of a dialog, a form or a settings
panel **is** the thing being mocked — clickable, correctly styled, light and dark. Never answer a
"show me what this would look like" with ASCII art or box-drawing characters.

`Modal` carries its own trigger: `trigger` is the button label, and the children are the dialog
body. A button and the confirmation dialog it opens are therefore one component, not two.

None of this needs `canvas_data` — the pipeline below applies to `Chart` and `DataTable`, which
bind to a path. A UI mock is `canvas_create` then `canvas_update`, and that is all:

```json
{ "surfaceId": "mock", "title": "Delete worktree" }
```

```json
{
  "surfaceId": "mock",
  "components": [
    {
      "id": "modal",
      "component": "Modal",
      "trigger": "Delete worktree",
      "title": "Delete this worktree?",
      "children": ["warn", "actions"]
    },
    {
      "id": "warn",
      "component": "Text",
      "text": "This deletes the directory and its branch.",
      "muted": true
    },
    {
      "id": "actions",
      "component": "Row",
      "equalWidth": false,
      "gap": 2,
      "children": ["cancel", "confirm"]
    },
    { "id": "cancel", "component": "Button", "label": "Cancel", "variant": "outline" },
    { "id": "confirm", "component": "Button", "label": "Delete", "variant": "destructive" }
  ]
}
```

One limit worth knowing before you promise something the renderer will not deliver: a `Modal`
trigger is always `variant="outline"`, so a destructive-looking trigger needs a separate `Button`
placed next to it.

## Collecting an answer: `canvas_await`

Controls report nothing by default — a mock demonstrates appearance and arrangement, not
behaviour. They answer you only while a `canvas_await` call is pending, which is how you turn a
mock into a form that actually answers you.

Render the form with `canvas_update`, then call `canvas_await`. Maestro opens the surface, and the
call returns as soon as the user acts:

```json
{
  "event": {
    "surfaceId": "branch-form",
    "componentId": "confirm",
    "kind": "click",
    "values": { "branch": "main" }
  }
}
```

- `surfaceId` names the canvas the user acted on. **Omit `surfaceId` from the call** and the wait
  takes whichever canvas they use — they can page between every surface you have drawn, so
  guessing which one they are looking at is a guess you do not need to make. Pass it only to
  insist on one particular canvas — one that does not match a canvas you created waits for
  nothing, and you find out when the call times out.
- `kind` is `click` (a `Button`), `change` (a `CheckBox`, `ChoicePicker` or `Slider`) or `submit`
  (Enter in a `TextField` or `DateTimeInput`).
- `values` carries **every** field on that surface, not just the one that fired. That is what makes
  a multi-field form one round trip: label a submit `Button`, and read the fields off `values`.
  Fields are scoped per surface, so two forms may both use `branch` without colliding.
- Typing in a text field never resolves the wait on its own — otherwise the first keystroke would
  answer for a half-filled form.

`timeoutSeconds` is capped at 60 and defaults to 30. On expiry the call returns
`{"timeout": true}` and the controls stop reporting; call it again to keep waiting. What the user
already filled in stays on the surface, so a re-issued wait does not ask them to type it twice.

## Data Pipeline

Three tools. Order is mandatory:

1. **`canvas_create`** — always first for a new `surfaceId`. Establishes the surface and title.
2. **`canvas_data`** — push data BEFORE any `canvas_update` that references it. Data is stored at the JSON Pointer path you specify (e.g. `/rows`). Call it again to populate multiple paths or update data incrementally.
3. **`canvas_update`** — render or update components. Merges by component `id` — re-send a component with the same `id` to update it in place without rebuilding the whole surface.

**Correct order:**

```
canvas_create  →  canvas_data  →  canvas_update
```

**Wrong (component renders before data arrives → shows skeleton indefinitely):**

```
canvas_create  →  canvas_update  →  canvas_data   ✗
```

## Live streaming pattern

For dashboards that pull from other tool calls (MCP servers, shell commands, APIs):

1. `canvas_create` immediately — give the user a title while tools run
2. `canvas_update` with a skeleton layout — show structure using `Text` with `muted: true` as placeholders
3. For each tool call that returns data: call `canvas_data` then `canvas_update` to replace the placeholder
4. Don't wait for all calls to finish before showing anything

```
canvas_create { title: "Incident Dashboard" }
canvas_update { components: [ skeleton layout with Text "Loading error rate…" ] }
[call datadog MCP]
canvas_data { path: "/errorRate", value: [...] }
canvas_update { components: [ Chart bound to /errorRate, replacing skeleton ] }
[call sentry MCP]
canvas_data { path: "/alerts", value: [...] }
canvas_update { components: [ DataTable bound to /alerts ] }
```

## Chart Data Formats

**Cartesian (line / bar / area)** — array of objects, one per x-axis tick:

```json
{
  "path": "/data",
  "value": [
    { "month": "Jan", "revenue": 100, "cost": 80 },
    { "month": "Feb", "revenue": 150, "cost": 90 }
  ]
}
```

Component: `{ "component": "Chart", "type": "line", "data": "/data", "xKey": "month", "series": [{ "key": "revenue", "label": "Revenue" }, { "key": "cost", "label": "Cost" }] }`

**Pie** — array of objects, one per slice:

```json
{
  "path": "/slices",
  "value": [
    { "name": "Auth errors", "count": 45 },
    { "name": "DB timeouts", "count": 30 }
  ]
}
```

Component: `{ "component": "Chart", "type": "pie", "data": "/slices", "xKey": "name", "series": [{ "key": "count", "label": "Count" }] }`

## DataTable rows are positional

`columns` is a list of `{ key, label }`, but the rows are **arrays of cells indexed by column
position**, not objects keyed by `key`:

```json
{
  "path": "/rows",
  "value": [
    ["src-tauri", 124, 26115],
    ["maestro-server", 25, 6546]
  ]
}
```

An object like `{"crate": "src-tauri", "files": 124}` is not rejected — it renders as a table of
empty cells, because the renderer reads `row[j]` for column `j`. Nothing warns you, and
the schema accepts any array, so the tool does not reject it either.

## Component Selection

| Use case                     | Component                                                           |
| ---------------------------- | ------------------------------------------------------------------- |
| Numeric trends over time     | `Chart` type line or area                                           |
| Category comparisons         | `Chart` type bar                                                    |
| Proportions / breakdown      | `Chart` type pie                                                    |
| X/Y point clouds             | `Chart` type scatter — data `[{x, y}]`, xKey="x", series key="y"    |
| Multi-axis comparisons       | `Chart` type radar — data `[{subject, val1, val2}]`                 |
| Progress / ranking bars      | `Chart` type radialBar — data `[{name, value}]`                     |
| Conversion steps             | `Chart` type funnel — data `[{name, value}]`                        |
| Part-of-whole hierarchy      | `Chart` type treemap — data `[{name, size, children?}]`             |
| Mixed line + bar + area      | `Chart` type composed — add `seriesType` per series item            |
| Hierarchical radial          | `Chart` type sunburst — single root `{name, value, children:[...]}` |
| Filterable or paged rows     | `DataTable` — or when paired with a `Chart`                         |
| Prose, formatted text        | `Markdown`                                                          |
| Stat callout (KPI)           | `Row` of `Card` each containing `Text` variant subheading           |
| Multi-section layout         | `Tabs` with one child per tab, or `Column` of `Card`                |
| A control, an action         | `Button` — variants default/outline/ghost/destructive/secondary     |
| A dialog and its trigger     | `Modal` — `trigger` is the button label, children are the body      |
| A form field                 | `TextField`, `CheckBox`, `ChoicePicker`, `Slider`, `DateTimeInput`  |
| UI the catalog can't express | `Html` — themed iframe, fine for a mock                             |
| Custom viz not in catalog    | `Html` — last resort only                                           |

For **data visualization**, prefer catalog components over `Html` whenever they cover the use case
— it adds boilerplate and breaks on data with special characters. For a **UI mock** the trade runs
the other way: once the arrangement needs placement, spacing or states the catalog components do
not have, `Html` is the right tool, and the theme variables below keep it looking native.

`Html` has restrictions: no double-quotes or backslashes in `srcdoc` — escape all data as single-quoted JS or use JSON.stringify carefully.

## Html theming

The `Html` component receives Maestro's theme CSS variables automatically in the iframe:

```
--background, --foreground, --card, --card-foreground,
--muted, --muted-foreground, --border,
--accent, --accent-foreground,
--primary, --primary-foreground,
--input, --ring
```

`body` also receives `background: var(--background)`, `color: var(--foreground)` and
`font-family: system-ui, sans-serif`.

Use those variables. Never define a custom `:root {}` color scheme — it overrides the theme.

## Tabs Layout Rule

Always add a `children` array to any `Tabs` component that mirrors its `tabs[].childId` values:

```json
{
  "id": "my-tabs",
  "component": "Tabs",
  "children": ["tab-a", "tab-b"],
  "tabs": [
    { "label": "A", "childId": "tab-a" },
    { "label": "B", "childId": "tab-b" }
  ]
}
```

The root-detection pass only scans `children` arrays to find owned nodes. Without this, tab content is treated as a root and rendered flat below the tabs widget. `CanvasTabs` ignores `children` (it reads `tabs[].childId`), so adding it is harmless — it only affects root-detection.

## Chart Color Rule

Always pass an explicit `color` hex value on every series item:

```json
"series": [{ "key": "revenue", "label": "Revenue", "color": "#6366f1" }]
```

The fallback PALETTE (`--chart-N` CSS vars) is greyscale in this theme regardless of light/dark mode. Without explicit colors every series renders in grey. `ChartContainer` injects `--color-<key>: <color>` from the series color, which the chart then uses via `var(--color-<key>)`.

Pie chart slices use the internal PALETTE directly (not series color) — they will always be grey. Prefer `bar` over `pie` when color variety matters.

## Anti-patterns

- **Inline large data in props** — put arrays in `canvas_data`, reference by JSON Pointer. Don't embed `value: [[...100 rows...]]` directly in a component prop.
- **canvas_update before canvas_data** — the Chart and DataTable will show skeletons and never populate.
- **New surfaceId per update** — reuse the same surfaceId; `canvas_update` merges by component id. Creating a new surface per tool call produces many disconnected panels.
- **Html when Chart/DataTable covers it** — adds boilerplate and breaks on data with special characters. This is about charts and tables; for a UI mock `Html` is a legitimate first choice.
- **ASCII art for a UI mock** — box-drawing characters convey no styling, no states and no spacing. Use the real `Button` and `Modal`, `Html`, or an `svg` fence, in that order.
- **Narrating the tool calls** — the user sees a rendered surface. Never paste arguments, announce a render, or explain a retry.
- **Asking a question in prose next to a form** — if you rendered controls to get an answer, call `canvas_await`. Without it the user's clicks go nowhere.
- **Tabs without `children` array** — tab content renders as roots below the widget. Always mirror `tabs[].childId` into `children`.
- **Chart series without `color`** — all series render grey. Always pass explicit hex colors.
