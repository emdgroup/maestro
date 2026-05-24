# Ticket Field Analysis — Provider Comparison

Scope: what each provider's raw API exposes, what `RemoteIssue` currently captures,
what is discarded, and what `Task` would need to represent imported tickets faithfully.

---

## 1. Raw API fields per provider

### GitHub Issues API
| Field | Type | Notes |
|---|---|---|
| `number` | int | issue number within repo |
| `title` | string | |
| `body` | string? | markdown |
| `html_url` | string | |
| `labels[].name` | string[] | |
| `updated_at` | string? | ISO 8601 |
| `created_at` | string | not fetched |
| `assignees[].login` | string[] | not fetched |
| `milestone.title` | string? | not fetched |
| `state` | string | always "open" — filtered |
| `pull_request` | object? | present on PRs — excluded |
| priority | — | no native priority; label-based convention |

### GitLab Issues API
| Field | Type | Notes |
|---|---|---|
| `iid` | int | issue number within project |
| `id` | int | global issue ID |
| `title` | string | |
| `description` | string? | markdown |
| `web_url` | string | |
| `labels` | string[] | already normalized to strings |
| `updated_at` | string? | ISO 8601 |
| `created_at` | string | not fetched |
| `assignees[].name` | string[] | not fetched |
| `milestone.title` | string? | not fetched |
| `weight` | int? | story points equivalent — not fetched |
| priority | — | no native priority; label-based |

### Forgejo Issues API
Mirrors GitHub Issues API shape (Gitea-compatible):
| Field | Type | Notes |
|---|---|---|
| `number` | int | |
| `title` | string | |
| `body` | string? | markdown |
| `html_url` | string | |
| `labels[].name` | string[] | |
| `updated_at` | string? | ISO 8601 |
| `created_at` | string | not fetched |
| `assignees[].login` | string[] | not fetched |
| priority | — | no native priority; label-based |

### Linear GraphQL API
| Field | Type | Notes |
|---|---|---|
| `identifier` | string | e.g. `ENG-42` |
| `title` | string | |
| `description` | string? | markdown |
| `url` | string | |
| `updatedAt` | string? | ISO 8601 |
| `labels.nodes[].name` | string[] | |
| `priority` | int | 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low — **not fetched** |
| `assignee.name` | string? | not fetched |
| `state.name` | string | not fetched |
| `estimate` | float? | points — not fetched |
| `team.key` | string | not fetched |
| `createdAt` | string | not fetched |

### Jira Cloud REST API
| Field | Type | Notes |
|---|---|---|
| `key` | string | e.g. `PROJ-42` |
| `fields.summary` | string | |
| `fields.description` | ADF object? | converted to markdown via jc_adf |
| `fields.labels` | string[] | |
| `fields.updated` | string? | ISO 8601 |
| `fields.priority.name` | string? | Highest/High/Medium/Low/Lowest — **not fetched** |
| `fields.assignee.displayName` | string? | not fetched |
| `fields.issuetype.name` | string | Bug/Story/Task/Epic etc. — not fetched |
| `fields.created` | string | not fetched |
| `fields.status.name` | string | not fetched (filtered to non-Done via JQL) |
| `fields.components[].name` | string[] | not fetched |

### Azure DevOps Work Items API
| Field | Type | Notes |
|---|---|---|
| `id` | int | |
| `System.Title` | string | |
| `System.Description` | string? | HTML — not converted, stored raw |
| `System.ChangedDate` | string? | ISO 8601 |
| `System.Tags` | string? | semicolon+space separated: `"bug; urgent"` |
| `System.WorkItemType` | string | Bug/User Story/Task/Epic etc. — in WIQL_FIELDS but not used |
| `System.State` | string | not fetched (filtered to non-Closed via WIQL) |
| `System.AssignedTo.displayName` | string? | not fetched |
| `System.CreatedDate` | string | not fetched |
| `Microsoft.VSTS.Common.Priority` | int? | 1=Critical,2=High,3=Medium,4=Low — **not fetched** |
| `Microsoft.VSTS.Scheduling.Effort` | float? | not fetched |

---

## 2. RemoteIssue — current shape

```rust
pub struct RemoteIssue {
    pub external_id: String,   // provider:{identifier}
    pub title: String,
    pub body: Option<String>,  // always markdown (Jira ADF converted)
    pub url: String,
    pub labels: Vec<String>,
    pub updated_at: Option<String>,
}
```

**What RemoteIssue normalizes well:**
- `external_id` — namespaced (`github:42`, `jira:PROJ-42`, `linear:ENG-42`)
- `title` — consistent across all providers
- `body` — always markdown (ADF converted for Jira; raw HTML for AzDo — this is a bug)
- `url` — consistent
- `labels` — normalized to `Vec<String>` even when provider uses different shapes
- `updated_at` — consistent timestamp for change detection

**What RemoteIssue silently discards:**

| Lost field | Providers that have it | Impact on Task |
|---|---|---|
| `priority` | Linear, Jira, AzDo (partial) | Cannot set `Task.priority` from remote |
| `assignee` | All providers | No assignee concept in Task (V1 scope OK) |
| `issue_type` | Jira, AzDo, (Linear) | Could inform Task name prefix or label |
| `created_at` | All providers | Minor — Task gets its own `created_at` |
| `milestone` | GitHub, GitLab, Forgejo, AzDo | No milestone concept in Task (V1 scope OK) |
| `estimate` | Linear, GitLab (weight), Jira, AzDo | No estimate concept in Task (V1 scope OK) |

**AzDo body bug:** `System.Description` is HTML. All other providers deliver markdown or have it
converted. AzDo currently stores HTML raw in `RemoteIssue.body` — it will render as broken
markdown in Task description.

---

## 3. Task struct — current shape vs. ticketing needs

### What Task has that maps cleanly from RemoteIssue
| Task field | Maps from | Notes |
|---|---|---|
| `name` | `RemoteIssue.title` | direct |
| `external_id` | `RemoteIssue.external_id` | direct |
| `is_imported` | hardcoded `true` | |
| `import_source` | derived from `external_id` prefix | `"github"`, `"jira"`, etc. |
| `status` | hardcoded `Backlog` | provider state ignored |
| `priority` | **no source in RemoteIssue** | defaults to `Medium` on import |

### What Task is missing that ticketing needs
| Missing field | Why needed |
|---|---|
| `external_url` | "Open in provider" link; change detection UI |
| `external_updated_at` | Change detection: compare against `RemoteIssue.updated_at` |
| `labels` | Show/filter imported tasks by provider label |

These three are in the DB schema (V16) but not in the Rust `Task` struct,
`TASK_SELECT`, or `Task::from_row`. They must be added before Phase 56 runs.

### What Task has that doesn't map from any provider
| Task field | Problem |
|---|---|
| `description` | Providers have a single body field. Task splits description/AC. |
| `acceptance_criteria` | No provider concept. |
| `base_branch` | No provider concept — hardcoded to project default on import. |
| `skills` | No provider concept — empty on import. |

---

## 4. The description/acceptance_criteria split problem

Task was designed for locally-authored tasks where an agent needs a clear description
and a checklist of acceptance criteria. Providers have one body field.

**Options:**

**A. body → description, acceptance_criteria = null**
Simple. User can add AC manually after import. Body renders as description in UI.

**B. body → acceptance_criteria, description = empty**
Wrong direction. Body in most providers is the issue description, not acceptance criteria.

**C. Parse body for AC patterns**
Fragile. `## Acceptance Criteria\n- [ ] ...` exists in well-structured Jira/Linear issues
but not universally. Cannot rely on it.

**Recommendation: A.** `body → description`, `acceptance_criteria = null`.
Import is a starting point — users refine before running an agent.

---

## 5. Priority mapping

Providers that have native priority:

| Provider | Values | Maestro mapping |
|---|---|---|
| Linear | 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low | 0→Medium, 1→Urgent, 2→High, 3→Medium, 4→Low |
| Jira | Highest, High, Medium, Low, Lowest | Highest→Urgent, High→High, Medium→Medium, Low/Lowest→Low |
| AzDo | 1=Critical, 2=High, 3=Medium, 4=Low | 1→Urgent, 2→High, 3→Medium, 4→Low |
| GitHub | none (label convention) | always Medium |
| GitLab | none (label convention) | always Medium |
| Forgejo | none (label convention) | always Medium |

**To use native priority:** `RemoteIssue` needs a `priority: Option<String>` field,
populated by each provider's fetch function, normalized to Maestro values.

**To ignore native priority:** always import as Medium. User adjusts manually.

This is a decision point — see Section 6.

---

## 6. RemoteIssue extension options

### Option A — Keep RemoteIssue minimal (current)
No changes to `RemoteIssue`. Priority always defaults to Medium on import.
Fast, no provider changes needed.

**Tradeoff:** Users with Jira/Linear/AzDo lose priority data. They must re-set it manually.

### Option B — Add priority to RemoteIssue
```rust
pub struct RemoteIssue {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub labels: Vec<String>,
    pub updated_at: Option<String>,
    pub priority: Option<String>,  // "Urgent" | "High" | "Medium" | "Low" | null
}
```
Each provider fetch function normalizes priority to Maestro values before returning.
GitHub/GitLab/Forgejo return `None` → defaults to Medium at import.

**Tradeoff:** 3 provider files need updating; TypeScript bindings change; more test surface.
But priority is a first-class Task field — losing it silently on import is a real UX gap.

### Option C — Full provider-native fields (over-engineered for Phase 56)
Add `issue_type`, `assignee`, `milestone`, etc. Much wider scope.

---

## 7. AzDo HTML body bug

`System.Description` in Azure DevOps is HTML, not markdown. Current code stores it raw.
When rendered in Task description it will show `<p>`, `<ul>`, etc. as literal text.

Fix: add HTML→markdown conversion in `azure_devops.rs` (similar to how Jira uses `jc_adf`).
Options: `htmd` crate, `html2text` crate, or strip tags with a simple regex (lossy).

---

## 8. Recommended decisions for Phase 56

| Decision | Recommendation | Rationale |
|---|---|---|
| `body` mapping | `body → description`, `acceptance_criteria = null` | Single provider field; AC is agent-workflow concept |
| Priority on import | Add `priority: Option<String>` to `RemoteIssue`; populate for Linear/Jira/AzDo | First-class field in Task; silent loss is UX regression |
| Task struct additions | Add `external_url`, `external_updated_at`, `labels` | Already in DB schema V16; needed for change detection |
| AzDo HTML body | Convert HTML→markdown in `azure_devops.rs` | Consistency; markdown is the internal contract |
| `base_branch` | Use project default | No provider concept |
| `skills` | Empty `[]` | No provider concept |
| `status` | Hardcode `Backlog` | Import starts in backlog regardless of remote state |
