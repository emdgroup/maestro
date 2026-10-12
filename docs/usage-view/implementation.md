# Usage view: implementation plan

The design is `design.md` and `mock.html`. This file records how it is built. Phases are committed
separately.

## Decisions

Taken with the user on 2026-10-12, on top of the design's own:

- **A mirror, not queries on demand.** The app copies each connection's usage into its own
  database and queries it locally. Asking every attached daemon on each range or filter change was
  the alternative; it cannot show a connection that is not attached, and costs an SSH round trip
  per click.
- **Sync on attach, then only while the Usage view is open.** No background sync, and no push
  message from the daemon.
- **The app keeps the daemon's retention rule** (turns merged into hours after 90 days) rather
  than keeping turns for ever. This is what makes "sync again from scratch" lossless.
- **A SQL view** unions turns and hourly totals, so each chart is one `GROUP BY` over one shape.
- **Missing cost is zero, silently.** Turns with no per-model rows go to the session's model.
  Same path on two connections is two projects. Removed connections keep their usage.

## Phases

1. **Daemon: store id and `UsageSync`.** A `usage_meta` row in `projects.db` (migration
   `V11_USAGE_META`) holds a random store id, made on first use, and `merged_through_id`, the
   highest turn id `merge_old` has folded into hours. `ServerRequest::UsageSync { after_turn_id,
limit }` answers `UsageSyncOk { store_id, merged_through_id, turns, turn_models, hourly,
hourly_models, more }`: turns with an id above `after_turn_id` in id order, at most `limit`
   (default 5000) per answer with `more` set when there are further pages, and the hourly tables
   only when `after_turn_id` is `None`. `PROTOCOL_VERSION` goes from 15 to 16. Tests: paging, the
   first sync carrying hours, `merged_through_id` moving after a merge.
2. **App: mirror, sync and views.** Schema v33 adds `usage_stores` (store id, connection key, the
   connection's name at the last sync, last turn id, removed flag), mirror copies of the four
   daemon tables keyed by store id, and the two views (`usage_facts`, `usage_model_facts`). A
   `sync_usage(connection)` command pages through `UsageSync`, and starts the store over when the
   store id is new or when `merged_through_id` passes the app's last turn id. It merges the app's
   own turns older than 90 days at most once a day. Home's attach calls it once. Deleting a
   connection marks its stores removed instead of deleting them. Tests: incremental sync, a new
   store id, the 90-day gap, the merge, the views' totals equal the raw rows'.
3. **App: one report command.** `get_usage_report(query)` takes the range (start, end, bucket),
   the metric, the split and the filters, and returns in one answer the two totals and averages,
   the series, the heatmap (only for 7 days or more), the project and model breakdowns with their
   tokens by type, and the coverage (each store's connection, last sync time, attached or not).
   Buckets are computed with SQLite's `localtime`. `usage.service.ts` wraps it in a TanStack Query
   hook, plus a `useUsageSync` that calls `sync_usage` for every attached connection every 30 s
   while the view is mounted and invalidates the report after each. Tests: bucket boundaries in
   local time, filters, the model fallback.
4. **The Usage view and the Home tile.** `src/views/usage/` (title with the range popover over the
   shadcn `Calendar`, metric cards, main chart, heatmap, breakdowns, coverage line), the charts as
   inline SVG with no chart library, the tile in `Hero.tsx`, and the route between Home and the
   view. Tests: range presets to buckets, the Model and Token type splits disabled under Cost, the
   heatmap hidden under 7 days.
5. **Notes and checks.** `maestro-server/AGENTS.md` (`UsageSync`, the store id), `src-tauri/AGENTS.md`
   (the mirror tables and views), the root `AGENTS.md` (schema v33, protocol 16), and the note in
   `docs/home-dashboard/design.md`. A dev instance against This computer and one SSH host, with the
   SSH host detached part of the time.
