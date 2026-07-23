# Canvas Base Skill

Read the component catalog at `.maestro/canvas-catalog.json` for component props and fence syntax.
This file covers pipeline ordering, data formats, component selection, and failure patterns.

## Data Pipeline

Three message types. Order is mandatory:

1. **`canvas_create`** — always first for a new `surfaceId`. Establishes the surface and title.
2. **`canvas_data`** — push data BEFORE any `canvas_update` that references it. Data is stored at the JSON Pointer path you specify (e.g. `/rows`). Send multiple `canvas_data` messages to populate multiple paths or update data incrementally.
3. **`canvas_update`** — render or update components. Merges by component `id` — re-send a component with the same `id` to update it in place without rebuilding the whole surface.

**Correct order:**

```
canvas_create  →  canvas_data  →  canvas_update
```

**Wrong (component renders before data arrives → shows skeleton indefinitely):**

```
canvas_create  →  canvas_update  →  canvas_data   ✗
```

## MCP / Live Streaming Pattern

For dashboards that pull from tool calls (MCP servers, shell commands, APIs):

1. `canvas_create` immediately — give the user a title while tools run
2. `canvas_update` with a skeleton layout — show structure using `Text` with `muted: true` as placeholders
3. For each tool call that returns data: send `canvas_data` then `canvas_update` to replace the placeholder
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

## Component Selection

| Use case                  | Component                                                           |
| ------------------------- | ------------------------------------------------------------------- |
| Numeric trends over time  | `Chart` type line or area                                           |
| Category comparisons      | `Chart` type bar                                                    |
| Proportions / breakdown   | `Chart` type pie                                                    |
| X/Y point clouds          | `Chart` type scatter — data `[{x, y}]`, xKey="x", series key="y"    |
| Multi-axis comparisons    | `Chart` type radar — data `[{subject, val1, val2}]`                 |
| Progress / ranking bars   | `Chart` type radialBar — data `[{name, value}]`                     |
| Conversion steps          | `Chart` type funnel — data `[{name, value}]`                        |
| Part-of-whole hierarchy   | `Chart` type treemap — data `[{name, size, children?}]`             |
| Mixed line + bar + area   | `Chart` type composed — add `seriesType` per series item            |
| Hierarchical radial       | `Chart` type sunburst — single root `{name, value, children:[...]}` |
| Tabular data, many rows   | `DataTable`                                                         |
| Prose, formatted text     | `Markdown`                                                          |
| Stat callout (KPI)        | `Row` of `Card` each containing `Text` variant subheading           |
| Multi-section layout      | `Tabs` with one child per tab, or `Column` of `Card`                |
| Custom viz not in catalog | `Html` — last resort only                                           |

Prefer catalog components over `Html` whenever they cover the use case. `Html` has restrictions: no double-quotes or backslashes in `srcdoc` — escape all data as single-quoted JS or use JSON.stringify carefully.

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
- **Html when Chart/DataTable covers it** — adds boilerplate and breaks on data with special characters.
- **Skipping validate-canvas** — always run `maestro-server validate-canvas` before emitting a fence. Catch schema errors before the user sees a broken canvas.
- **Tabs without `children` array** — tab content renders as roots below the widget. Always mirror `tabs[].childId` into `children`.
- **Chart series without `color`** — all series render grey. Always pass explicit hex colors.
