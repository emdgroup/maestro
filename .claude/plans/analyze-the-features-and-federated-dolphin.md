# Maestro UAT Plan

## Context

Maestro is a Tauri desktop app orchestrating autonomous AI coding agents. Users manage tasks on a Kanban board, agents execute in isolated git worktrees with real-time monitoring. This UAT plan covers all user-facing features, their prerequisite gates, and end-to-end regression scenarios.

**No feature flags exist.** Gating is entirely state-dependent: connection type, preflight results, git repo status, agent availability, and task status.

---

## 1. PROJECT PICKER / CONNECTION SELECTION (Entry Gate)

**Prerequisites:** App installed. SSH server for SSH tests. Windows+WSL for WSL tests. One git dir, one non-git dir available.

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| PP-01 | P0 | Open local project | Launch > Local > browse git project > Open | Project opens; all tabs visible |
| PP-02 | P1 | Clone project | Local > Clone > paste URL > target dir > Confirm | Repo cloned, opens |
| PP-03 | P1 | SSH connect + open | Add SSH > auth > browse remote > Open | Preflight passes; project opens |
| PP-04 | P1 | WSL connection | (Win) WSL > select distro > browse > Open | WSL project opens |
| PP-G01 | P0 | Preflight blocks on missing maestro-server | Open project where binary absent | Error; no Ignore button; cannot proceed |
| PP-G02 | P1 | Preflight warns non-mandatory | git present but npx missing | Warning with Ignore button; can proceed |
| PP-G03 | P0 | Project lock prevents dual-open | Open in instance A > try in instance B | Lock error toast in B |
| PP-G04 | P0 | Lock released on navigate back | Open project > back to picker | Another instance can open |
| PP-G05 | P1 | Git init gate | Select non-git dir | Prompt: Initialize git? or Skip |
| PP-G06 | P1 | Skip git = reduced features | Non-git > Skip | Review column hidden; Worktrees shows gate |
| PP-E01 | P1 | SSH auth failure | Wrong password | Error; stays on form |
| PP-E02 | P1 | SSH timeout | Unreachable host | Timeout error; no hang |
| PP-E03 | P2 | Deleted project dir | Previously-opened dir removed | Graceful error |

**Env:** PP-03 = SSH. PP-04 = Windows/WSL.

---

## 2. KANBAN / TASK MANAGEMENT

**Prerequisites:** Git project opened (non-git for G04).

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| KB-01 | P0 | Create task | Ctrl+N > title > Save | Appears in Backlog |
| KB-02 | P0 | Edit backlog task | Click task > modify > Ctrl+S | Saved |
| KB-03 | P0 | DnD Backlog to Ready | Drag (agent assigned) | Moves to Ready |
| KB-04 | P1 | Assign agent | Backlog task > agent dropdown | agent_id saved |
| KB-05 | P1 | Task config overrides | Task Settings > model, mode, auto_approve | Settings persist |
| KB-06 | P2 | Attachments | Add file > reload | Attachment persists |
| KB-07 | P1 | Delete task | Ctrl+D > confirm | Removed |
| KB-G01 | P0 | Ready requires agent | Drag unassigned to Ready | Rejected: "Assign an agent" |
| KB-G02 | P0 | DnD limited to Backlog/Ready | Drag toward InProgress/Done | No effect |
| KB-G03 | P1 | Only Backlog editable | Click InProgress task > try edit | Readonly |
| KB-G04 | P1 | Review hidden non-git | Non-git board | 4 columns (no Review) |
| KB-E01 | P1 | Empty title rejected | Create with blank | Validation error |

---

## 3. TASK EXECUTION

**Prerequisites:** Git project, agent discovered, task in Ready with agent assigned.

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| EX-01 | P0 | Execute Ready task | Click Execute | InProgress; ACP spawns; agent works |
| EX-02 | P0 | Isolated worktree | isolated_worktree=true > Execute | New worktree branch created |
| EX-03 | P0 | Completes to Review | Agent finishes | Status -> Review; diff available |
| EX-04 | P1 | Model override | model_override set > Execute | Agent uses specified model |
| EX-05 | P1 | Auto-approve | auto_approve=true > Execute | No permission prompts |
| EX-06 | P1 | Auto-mode drains queue | Enable auto_mode + 3 Ready tasks | Executes up to max_concurrent |
| EX-07 | P1 | Review feedback injected | Rework > re-execute | Prompt includes prior comments |
| EX-G01 | P0 | No agent blocks | No agent + no default > Execute | Toast: "No agent configured" |
| EX-G02 | P1 | Spawn timeout | Agent hangs 30s+ | Timeout; cleanup; error |
| EX-G03 | P1 | Dirty worktree dialog | Uncommitted changes > Execute | Stash/Discard/Ignore dialog |
| EX-E01 | P1 | Stash path | Dirty > Stash | Stashed; executes clean |
| EX-E02 | P1 | Discard path | Dirty > Discard | Discarded; executes |
| EX-E03 | P1 | Concurrent limit | max=2; 3 tasks | Only 2 run simultaneously |

---

## 4. AGENTS VIEW

**Prerequisites:** Project opened; preflight completed.

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| AG-01 | P0 | View sessions | Agents tab with running sessions | Sidebar list; selected shows monitor |
| AG-02 | P0 | Spawn session | Ctrl+N > agent > worktree > Start | Session active; output streams |
| AG-03 | P0 | Send prompt | Type > submit | Agent responds |
| AG-04 | P1 | Close session | Ctrl+W | Terminated; removed |
| AG-05 | P1 | Terminal session | Select Terminal type | PTY opens; can type commands |
| AG-06 | P1 | History view | Ctrl+H | Past sessions listed |
| AG-G01 | P0 | No maestro-server = Terminal only | Binary missing | Only Terminal in spawn dialog |
| AG-G02 | P1 | Missing spawn_deps | npx missing | Agent button disabled + tooltip |
| AG-G03 | P1 | Worktree hidden non-git | Non-git > spawn | No worktree selector |
| AG-E01 | P1 | Process crash | Kill subprocess | Error state shown; closeable |
| AG-E02 | P1 | Interrupt turn | Mid-response > interrupt | Turn stops; session alive |

---

## 5. WORKTREES VIEW

**Prerequisites:** Git project with worktrees.

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| WT-01 | P0 | View list | Worktrees tab | Card grid with branch/status |
| WT-02 | P0 | Create worktree | Ctrl+N > base branch > name > Create | Appears in grid |
| WT-03 | P0 | Diff panel | Click card | Slides in with file changes |
| WT-04 | P1 | Stage files | Select > Stage | Moves to staged |
| WT-05 | P1 | Commit | Stage > message > Commit | Created; diff refreshes |
| WT-06 | P1 | Discard changes | Select > Discard | Reverted |
| WT-07 | P1 | Shelve | Select > Shelve > name | Stashed; worktree clean |
| WT-08 | P1 | Delete worktree | Delete button > confirm | Removed from disk + list |
| WT-09 | P1 | Scope selector | Switch Head/Branch/Commit | Diff recalculates |
| WT-G01 | P0 | Non-git gate | Non-git project | "Git Repository Required" + Init button |
| WT-E01 | P2 | Zombie cleanup | Dir deleted externally > refresh | Zombie detected and cleaned |
| WT-E02 | P1 | Delete with active session | Delete worktree used by agent | Warning/prevention |

---

## 6. CODE REVIEW WORKFLOW

**Prerequisites:** Task in Review with isolated worktree containing commits.

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| CR-01 | P0 | View diff | Click Review task | Diff panel shows agent changes vs base |
| CR-02 | P0 | Approve and merge | Approve > confirm | Squash merge; Done; worktree cleaned |
| CR-03 | P0 | Request changes | Add comments > Rework | InProgress; feedback attached for re-exec |
| CR-04 | P1 | Discard to Backlog | Discard > "Send to Backlog" | Worktree deleted; branch removed; Backlog |
| CR-05 | P1 | Cancel task | Discard > "Cancel" | Worktree deleted; task Cancelled |
| CR-06 | P1 | Inline comments | Click line > add comment | Saved; appears in rework summary |
| CR-G01 | P1 | Merge conflict | Agent branch conflicts > Approve | Rejected to InProgress with conflict feedback |
| CR-G02 | P1 | Pre-commit hook failure | Hook fails > Approve | Dialog with hook output; fix or force |
| CR-E01 | P2 | Empty diff | No code changes > Review | Approve works; Done; no merge needed |
| CR-E02 | P1 | Rework with active session | Session still alive > Rework | Feedback injected directly (no re-spawn) |

---

## 7. SSH CONNECTION HEALTH

**Prerequisites:** Active SSH project. Ability to simulate network drop.

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| SH-01 | P0 | Normal state | SSH project open | No overlay; interactive |
| SH-02 | P0 | Auto-reconnect | Brief interrupt | Backdrop: "Reconnecting (n/5)"; reconnects |
| SH-G01 | P0 | Disconnect blocks UI | Kill SSH | Full-viewport backdrop; no interaction |
| SH-G02 | P1 | Session parking | Drop while agent running | Parked; restored after reconnect |
| SH-E01 | P0 | Retries exhausted | Permanent loss | "Could not reconnect" + Leave button |
| SH-E02 | P1 | Leave connection | Click Leave | Returns to picker; lock released |

**Env:** All require SSH + disconnect simulation.

---

## 8. ISSUE TRACKING & REPO INTEGRATION

**Provider capabilities:**

| Provider | Issues | Repos | Auth | Config Fields |
|----------|--------|-------|------|---------------|
| GitHub | Y | Y | PAT or `gh` CLI | owner, repo |
| GitLab | Y | Y | PAT | instance_url, project_path, project_id |
| Forgejo | Y | Y | PAT | instance_url, owner, repo |
| Gitea | Y | Y | PAT | instance_url, owner, repo |
| Linear | Y | N | API key | team_id |
| Jira Cloud | Y | N | email + API token | site_url, email, project_key |
| Azure DevOps | Y | Y | PAT | org_url, project |
| Bitbucket | N | Y | App password | workspace, repo_slug |

**Prerequisites:** Test accounts + tokens for each provider. Self-hosted instances for GitLab/Forgejo/Gitea. Jira Cloud site. Linear workspace. Azure DevOps org. Bitbucket workspace.

### 8a. Provider Connection

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| IT-C01 | P1 | Connect GitHub | Integrations > GitHub > PAT > Save | Validated; "Connected as {username}" |
| IT-C02 | P1 | Connect GitLab | Integrations > GitLab > instance URL + PAT > Save | Validated against instance; connected |
| IT-C03 | P1 | Connect Forgejo | Integrations > Forgejo > instance URL + PAT > Save | Validated; connected |
| IT-C04 | P1 | Connect Gitea | Integrations > Gitea > instance URL + PAT > Save | Validated; token scopes checked (needs `read:user`) |
| IT-C05 | P1 | Connect Linear | Integrations > Linear > API key > Save | Validated; connected |
| IT-C06 | P1 | Connect Jira Cloud | Integrations > Jira > site URL + email + API token > Save | Validated; connected |
| IT-C07 | P1 | Connect Azure DevOps | Integrations > Azure DevOps > org URL + PAT > Save | Validated; connected |
| IT-C08 | P1 | Connect Bitbucket | Integrations > Bitbucket > app password > Save | Validated; connected |
| IT-C09 | P2 | GitHub via gh CLI | `gh auth` active; no manual PAT | Auto-detected; source shows "gh_cli"; disconnect disabled |
| IT-C10 | P1 | Multiple providers | Connect GitHub + Linear + Jira simultaneously | All show "Connected" in integrations list |
| IT-C11 | P1 | Disconnect provider | Connected provider > Disconnect | Credentials removed from keyring; status disconnected |

### 8b. Invalid Credentials / Error Handling

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| IT-V01 | P1 | Invalid GitHub PAT | Garbage token > Save | "Unauthorized" or similar; token NOT stored |
| IT-V02 | P1 | Invalid GitLab PAT | Wrong token > Save | Validation fails; descriptive error |
| IT-V03 | P1 | Gitea missing scope | Token without `read:user` > Save | "token is valid but missing the required 'read:user' scope" |
| IT-V04 | P1 | Jira missing fields | Omit site_url or email > Save | "jira_cloud: site_url required" or similar |
| IT-V05 | P1 | GitLab missing instance URL | No instance_url > Save | "gitlab: instance_url required" |
| IT-V06 | P2 | Unreachable self-hosted | Forgejo/Gitea/GitLab with bad URL > Save | Network error; descriptive message |
| IT-V07 | P2 | Expired token | Previously-valid token expired > reopen | Integration shows disconnected or re-auth prompt |

### 8c. Per-Project Issue Tracking Config

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| IT-P01 | P1 | GitHub project config | Settings > Issue Tracking > GitHub > owner + repo | Saved to .maestro/settings.json |
| IT-P02 | P1 | GitLab project config | Settings > Issue Tracking > GitLab > project_path | Saved; issues fetchable |
| IT-P03 | P1 | Linear project config | Settings > Issue Tracking > Linear > team_id | Saved; issues fetchable |
| IT-P04 | P1 | Jira project config | Settings > Issue Tracking > Jira > project_key | Saved; issues fetchable |
| IT-P05 | P1 | Azure DevOps project config | Settings > Issue Tracking > Azure DevOps > project | Saved; issues fetchable |
| IT-P06 | P1 | Forgejo project config | Settings > Issue Tracking > Forgejo > owner + repo | Saved; issues fetchable |
| IT-P07 | P1 | Gitea project config | Settings > Issue Tracking > Gitea > owner + repo | Saved; issues fetchable |
| IT-P08 | P1 | Bitbucket filtered from issues | Settings > Issue Tracking dropdown | Bitbucket NOT listed (repos-only provider) |
| IT-P09 | P2 | Switch provider | Change from GitHub to Linear on same project | Old config replaced; new provider active |

### 8d. Issue Import

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| IT-I01 | P1 | Import GitHub issues | Kanban > Import > select issues > Import | Tasks in Backlog with external_id; title/description mapped |
| IT-I02 | P1 | Import GitLab issues | Kanban > Import > select > Import | Tasks created from GitLab issues |
| IT-I03 | P1 | Import Linear issues | Kanban > Import > select > Import | Tasks created from Linear issues |
| IT-I04 | P1 | Import Jira issues | Kanban > Import > select > Import | Tasks created from Jira issues |
| IT-I05 | P1 | Import Azure DevOps work items | Kanban > Import > select > Import | Tasks created from ADO items |
| IT-I06 | P1 | Import Forgejo issues | Kanban > Import > select > Import | Tasks created from Forgejo issues |
| IT-I07 | P1 | Import Gitea issues | Kanban > Import > select > Import | Tasks created from Gitea issues |
| IT-I08 | P2 | Duplicate import prevention | Import same issue twice | No duplicate task; skipped via external_id |
| IT-I09 | P2 | Detect changed issues | Upstream issue modified > Sync | "Changed" tab shows updates; Update or Dismiss |
| IT-I10 | P2 | Large issue list | Provider with 100+ issues | Pagination/scrolling works; no timeout |

### 8e. Repo Clone via Integration

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| IT-R01 | P1 | Clone GitHub repo | Project Picker > Clone > GitHub repos listed > select > clone | Repo cloned; project opens; integration auto-linked |
| IT-R02 | P1 | Clone GitLab repo | Project Picker > Clone > GitLab repos listed > select > clone | Repo cloned from instance URL |
| IT-R03 | P1 | Clone Forgejo repo | Project Picker > Clone > Forgejo repos listed > select > clone | Repo cloned from self-hosted |
| IT-R04 | P1 | Clone Gitea repo | Project Picker > Clone > Gitea repos listed > select > clone | Repo cloned from self-hosted |
| IT-R05 | P1 | Clone Azure DevOps repo | Project Picker > Clone > ADO repos listed > select > clone | Repo cloned from org |
| IT-R06 | P1 | Clone Bitbucket repo | Project Picker > Clone > Bitbucket repos listed > select > clone | Repo cloned (Bitbucket = repos only) |
| IT-R07 | P2 | Repo search/filter | Type in repo search > filter | Repos filtered by name match |
| IT-R08 | P2 | Private repo clone | Select private repo > clone | Auth credentials used; clone succeeds |
| IT-R09 | P1 | Linear/Jira hidden from clone | Clone dialog with only Linear + Jira connected | No repo source shown (issues-only providers) |

### 8f. Integration Gates

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| IT-G01 | P2 | Missing integration on project open | Configured provider disconnected > reopen project | IntegrationMissingDialog: "Fix Integration" or "Remove Config" |
| IT-G02 | P1 | No integrations = empty state | Settings > Issue Tracking with nothing connected | "No integrations connected. Add from project picker" |
| IT-G03 | P2 | gh CLI disconnect blocked | GitHub via gh CLI > try Disconnect | Button disabled with "Managed by gh CLI" tooltip |

**Env:** Requires valid tokens/accounts per provider. Self-hosted instances for GitLab/Forgejo/Gitea.

---

## 9. SETTINGS

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| ST-01 | P1 | Theme toggle | Dark/Light/System | Immediate change; persists |
| ST-02 | P1 | Default agent | Select from discovered | Saved; used when task has no agent_id |
| ST-03 | P2 | Accent color | Pick color | UI accent updates |
| ST-04 | P2 | Enter key behavior | Toggle | Input behavior changes |
| ST-05 | P1 | Auto-mode + max_concurrent | Enable + set limit | Drains queue respecting limit |
| ST-E01 | P1 | Persist across restart | Change > quit > reopen | Retained |

---

## 10. AGENT LIFECYCLE (Observable States)

| ID | P | Description | Steps | Expected |
|----|---|-------------|-------|----------|
| AL-01 | P1 | State transitions visible | Send prompt; watch | spawning > thinking > acting > idle |
| AL-02 | P0 | Permission prompt | Agent requests perm (non-auto) | Dialog; approve/deny |
| AL-03 | P1 | Elicitation prompt | Agent asks question | Form appears; respond; continues |
| AL-04 | P1 | Interrupt | Mid-response > interrupt | Turn stops; session stays |
| AL-05 | P1 | Cancel | Cancel button | Process killed; removed |
| AL-G01 | P1 | Auto-approve bypasses | auto_approve=true | No prompts |
| AL-E01 | P1 | Process crash | Kill externally | Error state; closeable |
| AL-E02 | P1 | SSH disconnect recovery | Drop + reconnect | Session parks then restores |

**Env:** AL-E02 = SSH.

---

## 11. CROSS-CUTTING

### Keyboard Shortcuts

| ID | P | Description | Expected |
|----|---|-------------|----------|
| XC-01 | P0 | Ctrl+R blocked | No page reload |
| XC-02 | P1 | Ctrl+1-4 tabs | Navigate |
| XC-03 | P1 | Ctrl+N context-sensitive | Creates task/session per tab |
| XC-04 | P2 | Escape closes panels | Panel/modal closes |

### Data Persistence

| ID | P | Description | Expected |
|----|---|-------------|----------|
| XC-10 | P0 | Tasks survive restart | All present with correct status |
| XC-11 | P1 | Settings survive restart | Retained |
| XC-12 | P1 | SSH connections remembered | Listed; connectable without re-entry |
| XC-13 | P1 | Integration tokens persist | Still "Connected" |

---

## 12. END-TO-END REGRESSION

| ID | P | Description |
|----|---|-------------|
| RG-01 | P0 | **Full lifecycle:** Create > assign agent > Ready > Execute > Review > Approve > Done |
| RG-02 | P0 | **Rework cycle:** Execute > Review > Rework with comments > Re-execute (feedback included) > Approve |
| RG-03 | P1 | **Auto-mode:** Enable > 3 Ready tasks > concurrent limit respected > all complete |
| RG-04 | P1 | **SSH full flow:** Connect > open > create > execute > review > approve |
| RG-05 | P1 | **Non-git project:** Open non-git > create task > execute > Done (no merge) |
| RG-06 | P1 | **Interrupt + recover:** Execute > interrupt > returns to queue > re-execute succeeds |
| RG-07 | P1 | **Disconnect + recover:** SSH running > disconnect > reconnect > session restores > completes |
| RG-08 | P2 | **Import + execute:** Connect integration > import issues > auto-mode execute batch |
| RG-09 | P1 | **Worktree cleanup:** Isolated task approved > worktree + branch removed > grid reflects |
| RG-10 | P1 | **Multi-agent:** 2 tasks, different agents, execute simultaneously > both complete |

---

## Priority Summary

| Priority | Count | Scope |
|----------|-------|-------|
| P0 | ~18 | Blocks all usage: project open, lock, basic CRUD, execution trigger, review basics, disconnect blocking, data persistence |
| P1 | ~52 | Major feature: full execution flow, review workflow, agent lifecycle, SSH, auto-mode, integrations |
| P2 | ~17 | Minor/cosmetic: filters, animations, accent colors, edge cases with degradation |

## Environment Requirements

| Tag | What's Needed |
|-----|---------------|
| SSH | Accessible SSH server (can be localhost:2222 via Docker) |
| WSL | Windows machine with WSL2 + distro |
| Integration | Valid PATs for GitHub/Linear/Jira (test accounts) |
| Multi-instance | Ability to run 2 Maestro instances simultaneously |
| Agent | At least one ACP agent installed (Claude recommended) |

## Verification Approach

1. **P0 first pass** — block any release if failures
2. **P1 second pass** — document bugs with severity; release-gate on count
3. **P2 exploratory** — time-boxed session after P0/P1 pass
4. Each scenario: record actual vs expected; screenshot on failure
5. Regression suite (section 12) run on every release candidate
