# Feature Research

**Domain:** Ticket import UI — browse and import issues from GitHub, GitLab, Linear, and Jira Cloud into a Kanban task board
**Researched:** 2026-05-20
**Confidence:** HIGH (GitHub, GitLab, Linear, Jira API fields verified against official docs via Context7; OAuth flow verified against tauri-plugin-oauth docs; UX patterns drawn from Linear's own import docs and real tool analysis)

---

## Existing Task Model (Constraints)

The current `tasks` table (schema v15) provides the anchor for all import mapping:

| Column | Type | Import role |
|--------|------|-------------|
| `name` | TEXT | Maps from ticket title/summary |
| `description` | TEXT | Maps from ticket body/description |
| `acceptance_criteria` | TEXT | Synthesized placeholder at import time |
| `status` | TEXT | Always `Backlog` on import |
| `priority` | TEXT | Mapped from provider priority field |
| `external_id` | TEXT | Provider-native ticket ID/key |
| `is_imported` | INTEGER | Set to 1 on import |
| `import_source` | TEXT | Provider slug: `github`, `gitlab`, `linear`, `jira` |

**New columns required (schema v16):**

| Column | Type | Purpose |
|--------|------|---------|
| `external_url` | TEXT | Direct link to ticket in source system |
| `external_updated_at` | TEXT ISO-8601 | Snapshot of provider `updated_at` at import time — enables change detection |
| `labels` | TEXT JSON array | Labels/tags from source, stored as serialized string |

These three are the only additions needed. All other existing columns remain unchanged.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features a developer expects when any tool says "import issues." Missing these makes the feature feel broken.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| OAuth connect/disconnect per project | Every modern tool uses OAuth for issue trackers; PAT-only auth feels incomplete | MEDIUM | `tauri-plugin-oauth` spawns a temporary localhost server, captures the redirect, returns the code. Browser opens the provider auth URL. Token stored in OS keychain (via `tauri-plugin-store` or platform keychain). Config (provider, project/team IDs) in `.maestro/ticketing.json`. Each provider needs its own OAuth app client ID. |
| Browse tickets before importing | Users need to see what they're getting; blind sync is disorienting | MEDIUM | Modal dialog with a paginated list. Each row shows ticket title, ID badge, label chips, state badge. Page size 50. Load-more button for pagination (no infinite scroll — user needs control). |
| Available / Imported / Changed state tabs | Three-state view distinguishes fresh tickets from ones already on the board | MEDIUM | Three tabs in the modal header. "Available" = `external_id` not yet in tasks. "Imported" = `external_id` exists. "Changed" = imported AND provider `updated_at > external_updated_at`. |
| Checkbox multi-select + bulk import | Single import is tedious when pulling in a sprint's worth of tickets | LOW | Checkbox on each row, "Import N selected" button, disabled at 0 selected. Select-all checkbox in header. |
| Manual refresh button | Auto-refresh alone is insufficient when user just created a ticket moments ago | LOW | Button in modal header. Shows spinner during fetch. Updates the current tab's list. |
| Display ticket labels | Labels are the primary triage signal developers look at when choosing what to work on | LOW | Colored badge chips next to title. Read from provider, stored in `labels` column. No editing needed in modal. |
| Link back to source ticket | Users need to jump to context in the original tool | LOW | External link icon on each row. Opens `external_url` in system browser. Also shown on the Kanban task card after import. |
| Clear error on auth failure | OAuth can fail silently; users need to know the connection is broken | LOW | Toast + red "Disconnected" badge in connection settings when token refresh fails or API returns 401. |
| State filter (open/closed) | Default to open issues; power users occasionally want to import closed/done tickets for tracking | LOW | Segmented control or radio group in modal filter bar. Default: open only. Must exclude pull requests for GitHub (filter out responses with `pull_request` key present). |

### Differentiators (Competitive Advantage)

Features that make Maestro's import feel better than a blind auto-sync.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Change detection with "Changed" tab | Long-lived imported tickets drift out of sync. No other desktop task tool surfaces this without a full re-import. | MEDIUM | "Changed" tab lists tickets where provider's current `updated_at > external_updated_at`. Each row shows amber "Updated N days ago" badge. Two actions: "Update task" (re-pulls title/description/labels into existing task, bumps `external_updated_at`) and "Dismiss" (bumps `external_updated_at` without touching task content). |
| Auto-refresh polling while modal open | Keeps the list fresh without user action — essential for fast-moving sprints | LOW | Poll every 2 minutes while modal is mounted. TanStack Query `refetchInterval` on the issues query. Pause polling when window loses focus. |
| Provider-specific filter chips | Each tracker has different native idioms; one-size filter feels wrong | MEDIUM | One row of filter chips below state toggle. GitHub/GitLab: label multiselect. Linear: team dropdown (required for the query). Jira: JQL text field (power user). Text search (client-side against fetched results) is universal. |
| Acceptance criteria placeholder injection | Maestro tasks require `acceptance_criteria` (NOT NULL); imported tickets don't have one | LOW | At import time: `acceptance_criteria = "Imported from [Provider] — add acceptance criteria before starting."`. This satisfies the DB constraint without blocking import. Field is editable post-import. |
| Persist provider connection status visibly | Users with several projects forget which ones are connected | LOW | Small colored dot (green connected / gray disconnected / red error) next to the provider name in the project's Settings tab. Shown outside the modal so users know before they click "Import". |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Auto-import on project open | "Sync automatically so the board is always fresh" | Silently creates/updates tasks at startup, breaks users' mental model of what landed on their board. A "Changed" tab showing 5 items is far less dangerous than auto-pulling 30 tickets. | Auto-refresh polling inside the modal only. User always confirms what lands on the board. |
| Two-way sync (push Maestro task status back to the ticket) | "Close the GitHub issue when I merge" | Massive scope creep. Write access requires additional OAuth scopes. Linear, Jira, and GitLab have complex state machines with custom workflows. Mistakes are visible to the whole team. | Store `external_url`. User closes the ticket manually. OAuth scope is read-only. |
| Webhook-driven real-time updates | "Notify me the instant a ticket changes" | Requires a persistent public endpoint. Maestro is a desktop app. Users behind NAT or corporate VPN cannot receive webhooks. | 2-minute polling while modal open. Out of scope per v1.6 milestone. |
| Advanced query builder for GitHub/GitLab | "Add advanced filtering like JQL for all providers" | GitHub's issue search is weaker than JQL. Exposing a raw query field confuses non-Jira users. Creates inconsistent UX across providers. | Label + state filter chips for GitHub/GitLab/Linear. JQL field only for Jira where it is expected. |
| Import closed/done issues by default | "I want to track historical work too" | Clutters Backlog with Done items that AI agents should never start. Creates risk of agents picking up already-closed work. | Filter modal defaults to open issues. User can toggle to show closed, but they're hidden by default. |
| Multi-provider per project | "I use both GitHub and Linear for the same project" | Two providers means duplicate deduplication logic, conflicting `external_id` namespaces, doubled auth surface. | One active provider per project (stored in `.maestro/ticketing.json`). Switching providers clears the connection but preserves already-imported tasks. |

---

## Field Mapping by Provider

### GitHub Issues → Task

| Provider Field | API Key | Task Field | Notes |
|----------------|---------|------------|-------|
| Issue number | `number` | `external_id` | Stored as string `"123"` |
| Title | `title` | `name` | Truncate to 255 chars |
| Body (markdown) | `body` | `description` | Null body maps to empty string |
| Labels | `labels[].name` | `labels` (new column) | Array of strings, serialized as JSON |
| State | `state` | Filter control only, not stored | open/closed |
| HTML URL | `html_url` | `external_url` | Direct link to issue |
| Updated at | `updated_at` | `external_updated_at` | ISO-8601 |
| Priority | — (GitHub has no priority field) | `priority` defaults to `Medium` | |
| Acceptance criteria | — | `acceptance_criteria` | Placeholder injected at import |

**Filter options (GitHub REST API):** `state` (open/closed/all), `labels` (comma-separated), `milestone`, `assignee`, `since` (updated after timestamp), `sort` (created/updated/comments), `per_page` (max 100), `page`.

**Deduplication:** Filter response items where `pull_request` key is present — GitHub REST treats PRs as issues.

**Change detection field:** `updated_at` is returned on every issue response. Compare against stored `external_updated_at`.

Source: GitHub REST API `GET /repos/{owner}/{repo}/issues` — verified via Context7 `/websites/github_en_rest`.

### GitLab Issues → Task

| Provider Field | API Key | Task Field | Notes |
|----------------|---------|------------|-------|
| IID (project-scoped ID) | `iid` | `external_id` | Stored as `"45"`. More stable than global `id`. |
| Title | `title` | `name` | |
| Description | `description` | `description` | Markdown, no conversion needed |
| Labels | `labels[]` | `labels` | Flat array of strings from API |
| State | `state` | Filter control only | `opened` / `closed` |
| Web URL | `web_url` | `external_url` | |
| Updated at | `updated_at` | `external_updated_at` | ISO-8601 |
| Priority / weight | — (not in GitLab CE) | `priority` defaults to `Medium` | |

**Filter options:** `state` (opened/closed/all), `labels` (comma-separated), `milestone`, `assignee_username`, `search` (title + description), `order_by` (updated_at), offset or keyset pagination (keyset preferred in GitLab 18.3+).

**Self-hosted support:** The project base URL is configurable per-project in `.maestro/ticketing.json`. OAuth app must be registered on the self-hosted instance separately. Self-hosted is a P2 concern — cloud GitLab first.

Source: GitLab REST API `GET /projects/:id/issues` — verified via Context7 `/websites/gitlab_18_4`.

### Linear Issues → Task

| Provider Field | API Key | Task Field | Notes |
|----------------|---------|------------|-------|
| Identifier | `identifier` (e.g. `ENG-123`) | `external_id` | Human-readable, project-scoped, stable |
| Title | `title` | `name` | |
| Description | `description` | `description` | Markdown |
| Labels | `labels.nodes[].name` | `labels` | Nested GraphQL nodes |
| State name | `state.name` | Filter control only | Maps roughly to workflow states |
| URL | `url` | `external_url` | |
| Updated at | `updatedAt` | `external_updated_at` | |
| Priority | `priority` (0-4 integer) | `priority` | See mapping below |
| Team | `team.id` | Required filter — not stored as task field | Team ID fetched post-OAuth and stored in `.maestro/ticketing.json` |

**Priority mapping:** Linear 1 → Urgent, 2 → High, 3 → Medium, 4 → Low, 0 → Medium (no priority assigned).

**Filter options:** GraphQL filter object supports `state` (by name or ID), `priority` (numeric comparator), `team`, `label`, `assignee`. Cursor-based pagination via Relay `first`/`after`.

**Team selection requirement:** Linear data is team-scoped. The team must be selected during OAuth connection setup and stored in config. Without a team ID the GraphQL query cannot be scoped correctly.

Source: Linear GraphQL API — verified via Context7 `/websites/linear_app_developers`.

### Jira Cloud Issues → Task

| Provider Field | API Key | Task Field | Notes |
|----------------|---------|------------|-------|
| Key | `key` (e.g. `PROJ-123`) | `external_id` | Project-scoped, human-readable, stable |
| Summary | `fields.summary` | `name` | |
| Description | `fields.description` (ADF) | `description` | ADF must be stripped to plaintext — see note |
| Labels | `fields.labels[]` | `labels` | Flat array of strings |
| Status | `fields.status.name` | Filter via JQL only | |
| URL | Constructed: `{jira_host}/browse/{key}` | `external_url` | Not returned directly by API |
| Updated | `fields.updated` | `external_updated_at` | ISO-8601 |
| Priority | `fields.priority.name` | `priority` | See mapping below |

**Priority mapping:** "Highest" → Urgent, "High" → High, "Medium" → Medium, "Low" / "Lowest" → Low.

**ADF (Atlassian Document Format):** Jira descriptions are JSON document trees, not markdown. Converting ADF to readable text requires walking `content` arrays and extracting `text` nodes. Full markdown conversion is non-trivial and deferred to v2. MVP: strip to plaintext by recursively extracting `text` node values. Blank ADF documents map to empty string.

**Filter via JQL:** The `GET /rest/api/3/search` endpoint accepts a JQL string. Sensible default: `project = "{project_key}" AND statusCategory != Done ORDER BY updated DESC`. User can override via the JQL text field in the modal.

**Pagination:** Offset-based via `startAt` + `maxResults` (max 100). `nextPageToken` available in newer API versions.

Source: Jira Cloud REST API v3 `GET /rest/api/3/search` — verified via Context7 `/websites/developer_atlassian_cloud_jira_platform_rest_v3`.

---

## Filter and Search Options (In-Modal UX)

The filter bar is intentionally minimal. Power users have the source tool for complex filtering.

### Universal (all providers)

| Filter | UX | Notes |
|--------|-----|-------|
| Text search | Input field, client-side filter on fetched titles | Filters the currently loaded page. For Jira, text input populates into the JQL as `AND text ~ "query"`. For GitHub, populates `q=` param on next fetch. |
| State toggle | "Open / Closed / All" segmented control | Default: Open. |

### Provider-specific

| Provider | Additional Filter | Why Required |
|----------|------------------|--------------|
| GitHub | Labels multiselect (P2) | Labels are primary triage signal |
| GitLab | Labels multiselect (P2) | Same as GitHub |
| Linear | Team dropdown (P1) | Query is team-scoped; required for the API call to work |
| Jira | JQL text field (P1) | Jira users expect JQL; simpler filters are inadequate for Jira's complexity |

**Deliberately omitted from v1.6:** Milestone filter, assignee filter, date range filter. These add surface area without covering the primary case (a developer importing their own sprint work into Maestro).

---

## "Changed" Ticket Surfacing

Change detection is the highest-value and most nuanced UX problem in this feature.

**Detection logic:**

1. At import time: store provider's `updated_at` into `external_updated_at`.
2. At import time: store the fetched description into `description` (already happens naturally).
3. On each modal open / poll cycle: for all `is_imported = 1` tasks with matching `import_source` for this project, compare stored `external_updated_at` against the provider's current `updated_at` for those ticket IDs.
4. If provider `updated_at > external_updated_at` → show in the "Changed" tab.

**"Changed" tab UX:**

- Same row layout as "Available" tab (title + ID + labels + state badge).
- Amber "Updated" badge showing relative time ("3 days ago").
- Two action buttons per row: **"Update task"** (re-fetches current title/description/labels from provider, writes into the existing task, bumps `external_updated_at`) and **"Dismiss"** (bumps `external_updated_at` to now without touching task content — user acknowledges the change but keeps their local edits).
- Clicking anywhere else on the row shows a simple two-column text layout: stored description (left) vs current provider description (right). No need for a full diff viewer — static text comparison is sufficient for MVP.

**What NOT to do:**

- Do not auto-apply upstream changes to task content. Users may have intentionally edited the imported description. The "Changed" state is a signal, not an automatic update.
- Do not show "Changed" tickets in the "Available" tab. They are already imported.
- Do not delete tasks from the board when a ticket is closed upstream. Surface "Closed upstream" as a sub-state in "Changed" tab (P2 — requires fetching state on every poll cycle).

---

## OAuth Connection Flow

Using `tauri-plugin-oauth` (confirmed pattern via Context7):

1. User clicks "Connect [Provider]" in project Settings.
2. Frontend calls `start({ ports: [8080, 8081] })` to spawn the localhost redirect server.
3. Frontend listens for `onUrl()` callback.
4. Frontend opens the provider OAuth URL in system browser with `redirect_uri = http://127.0.0.1:{port}`.
5. User authenticates in browser. Provider redirects back to localhost with `?code=...`.
6. `onUrl()` receives the URL. Frontend extracts `code`.
7. Rust backend performs token exchange (POST to provider token endpoint with `code` + `client_secret`). Client secret lives in Rust, never in frontend JS.
8. Access token + refresh token stored in OS keychain (platform-appropriate: Keychain on macOS, Credential Manager on Windows, libsecret on Linux).
9. Provider-specific config (repo owner/name, team ID, project key, base URL) stored in `.maestro/ticketing.json`.
10. Frontend calls `cancel(port)` to stop the localhost server.

**Scopes required:**

| Provider | OAuth Scope | Notes |
|----------|-------------|-------|
| GitHub | `repo` (read access to issues) or `public_repo` for public repos | `read:org` if repo is in an org. Read-only — no write scopes. |
| GitLab | `read_api` | Covers issues read access |
| Linear | `read` | Issues read access |
| Jira Cloud | `read:jira-work` | Classic scope; `read:issue-details:jira` granular |

---

## Feature Dependencies

```
OAuth Connection (per project)
    └──required by──> Import Modal (no token = modal shows "Connect" prompt instead of tickets)
                         ├──required by──> Change Detection ("Changed" tab)
                         │                    └──requires──> external_updated_at column (schema v16)
                         ├──requires──> external_url column (schema v16)
                         └──requires──> labels column (schema v16)

Auto-refresh polling
    └──enhances──> Import Modal (needs modal lifecycle to start/stop interval)

Linear Team Selector
    └──required by──> Linear import (team ID scopes the GraphQL query)
    └──stored in──> .maestro/ticketing.json (during OAuth connection setup)

ADF Plaintext Stripping
    └──required by──> Jira import (description field unusable without it)
```

### Dependency Notes

- **OAuth before import:** If no connection exists, the import modal shows "Connect [Provider]" with a button that triggers the OAuth flow inline. It does not navigate away to Settings.
- **Schema v16 before any import write:** All three new columns must exist. Added in the same migration; schema version bumps to 16.
- **Linear requires team selection during OAuth setup:** The modal prompts for team selection as a final step of the connection flow. Fetches available teams via `viewer.teams` query after token is stored.
- **Change detection only for already-imported tickets:** The "Changed" tab is empty until at least one ticket has been imported. This is expected, not a bug.
- **ADF stripping is not optional for Jira:** Without it, Jira descriptions will contain raw JSON blobs in the `description` field. The stripping logic is small (recursive walk) but must ship with the Jira import.

---

## MVP Definition

### Launch With (v1.6)

- [x] OAuth connect/disconnect per project (GitHub, GitLab cloud, Linear, Jira Cloud) — required for any import to work
- [x] Schema v16: `external_url`, `external_updated_at`, `labels` columns — required by all import writes
- [x] Remove existing broken GitHub/Jira import code (ImportSettings.tsx, SyncButton.tsx, sync.rs, related IPC handlers) — clean slate before building the replacement
- [x] Import modal triggered from Backlog column "Import tickets" button — core UX entry point
- [x] Available / Imported / Changed tabs — three-state view users immediately understand
- [x] Checkbox multi-select + "Import N selected" action — batch import is table stakes
- [x] Field mapping for all four providers — must work at launch or the feature is incomplete
- [x] State filter (open/closed toggle) — minimum viable filtering
- [x] Text search on fetched results (client-side) — users expect this in any list UI
- [x] Linear team selector in OAuth setup + filter bar — required for the API to work
- [x] JQL text field for Jira — Jira users expect this
- [x] ADF plaintext stripping for Jira descriptions — Jira is unusable without this
- [x] Auto-refresh polling every 2 minutes while modal open — keeps list fresh
- [x] Manual refresh button — instant reload without waiting for poll interval
- [x] "Changed" tab with "Update task" and "Dismiss" actions — named v1.6 requirement
- [x] Acceptance criteria placeholder on import — required by DB NOT NULL constraint
- [x] External link icon on modal rows and task cards — expected UX

### Add After Validation (v1.x)

- [ ] Label filter chips (GitHub/GitLab) — useful but state filter covers 80% of cases first
- [ ] Full ADF → markdown conversion for Jira — better rendering quality, not blocking launch
- [ ] GitLab self-hosted support — needs per-project base URL config; cloud first
- [ ] "Closed upstream" detection in Changed tab — requires fetching state on every poll
- [ ] Description diff view in Changed tab — static two-column text comparison first, diff later

### Future Consideration (v2+)

- [ ] Webhook-driven updates — requires public endpoint; out of scope for desktop app
- [ ] Two-way sync (push task status back to ticket) — write access, high complexity, high risk
- [ ] Multi-provider per project — creates `external_id` namespace collisions
- [ ] Import sub-tasks / epics as task relationships — significant schema work
- [ ] GitHub Projects v2 integration — different API surface from Issues

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| OAuth connection UI (all 4 providers) | HIGH | MEDIUM | P1 |
| Schema v16 column additions | HIGH | LOW | P1 |
| Remove old import code | HIGH | LOW | P1 |
| Import modal — Available tab | HIGH | MEDIUM | P1 |
| Import modal — Imported tab | HIGH | LOW | P1 |
| Import modal — Changed tab | HIGH | MEDIUM | P1 |
| Field mapping (GitHub, GitLab, Linear, Jira) | HIGH | MEDIUM | P1 |
| ADF stripping for Jira | HIGH | LOW | P1 |
| State filter (open/closed) | HIGH | LOW | P1 |
| Checkbox multi-select + bulk import | HIGH | LOW | P1 |
| Linear team selector | HIGH | LOW | P1 — required for Linear to work |
| JQL field for Jira | HIGH | LOW | P1 |
| Auto-refresh polling (2 min) | MEDIUM | LOW | P1 |
| Manual refresh button | MEDIUM | LOW | P1 |
| Acceptance criteria placeholder | MEDIUM | LOW | P1 — required by DB constraint |
| Text search (client-side) | MEDIUM | LOW | P1 |
| External link on rows + task cards | MEDIUM | LOW | P1 |
| Label filter chips (GitHub/GitLab) | MEDIUM | LOW | P2 |
| Full ADF → markdown conversion | MEDIUM | MEDIUM | P2 |
| GitLab self-hosted | MEDIUM | MEDIUM | P2 |
| Description diff view (Changed tab) | MEDIUM | MEDIUM | P2 |

**Priority key:**
- P1: Must ship in v1.6
- P2: Should add in v1.6.x patch
- P3: Future consideration

---

## Competitor Reference

| UX Pattern | Linear's own import | Maestro v1.6 approach |
|------------|---------------------|----------------------|
| Import flow | Wizard (5 steps, all-or-nothing) | Modal with tabs — stays in context, no page navigation |
| Change detection | Delete + re-import (destructive) | Non-destructive: "Changed" tab with Update/Dismiss per ticket |
| Filtering | Open vs closed/archived | Open/closed toggle + provider-specific chips |
| Re-import after change | Must delete the entire import | Per-ticket "Update task" action |
| Auth model | OAuth per Linear workspace | OAuth per project (different repos/teams per project) |
| Ticket link back | Not preserved | `external_url` stored, shown as link on task card |

---

## Sources

- GitHub REST API (`GET /repos/{owner}/{repo}/issues`): Context7 `/websites/github_en_rest` — HIGH confidence
- GitLab REST API (`GET /projects/:id/issues`): Context7 `/websites/gitlab_18_4` — HIGH confidence
- Linear GraphQL API (issues query, filter, pagination): Context7 `/websites/linear_app_developers` — HIGH confidence
- Jira Cloud REST API v3 (`GET /rest/api/3/search`): Context7 `/websites/developer_atlassian_cloud_jira_platform_rest_v3` — HIGH confidence
- tauri-plugin-oauth (localhost redirect OAuth flow): Context7 `/fabianlars/tauri-plugin-oauth` — HIGH confidence
- Linear import UX docs: https://linear.app/docs/import-issues — MEDIUM confidence (wizard pattern, state filtering, change detection via delete)
- GitHub filter docs: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests — HIGH confidence
- Existing codebase: `src/components/task/ImportSettings.tsx`, `src/components/common/SyncButton.tsx`, `src-tauri/src/models/sync.rs`, `src/services/project.service.ts`, `src-tauri/src/db/schema.rs` — HIGH confidence (direct inspection)

---

*Feature research for: Ticketing integration — v1.6 milestone*
*Researched: 2026-05-20*
