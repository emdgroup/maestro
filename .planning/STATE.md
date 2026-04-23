---
gsd_state_version: 1.0
milestone: v1.5
milestone_name: ACP Integration
status: completed
last_updated: "2026-04-23T01:09:05.505Z"
progress:
  total_phases: 8
  completed_phases: 5
  total_plans: 13
  completed_plans: 13
---

# Project State: v1.5 — ACP Integration

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-17)

**Core value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control
**Current focus:** Phase 48 — frontend-permissiondialog

## Current Position

Phase: 47 (frontend-agentactivitypanel) — COMPLETE
Plan: 3 of 3

## Performance Metrics

**Velocity:**

- Total plans completed across all phases: 21
- Average duration: 0.118 hours
- Total execution time: 2.46 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 13 | 2 | 0.19h | 0.095h |
| 14 | 4 | 0.46h | 0.115h |
| 15 | 3 | 0.43h | 0.143h |
| 16 | 2 | 0.23h | 0.115h |
| 17 | 2 | 0.33h | 0.165h |
| 17.1 | 4 | 0.52h | 0.130h |
| 18 | 4 | 0.82h | 0.205h |
| 19 | 3+ | 0.16h | 0.053h |

**Recent Trend:**

- Phase 13-01: 0.1h (Bug fixes - clean build, mock code exclusion)
- Phase 13-02: 0.09h (Documentation - pattern reference and code comments)
- Phase 14-01: 0.05h (Tailwind CSS setup - foundation for component styling)
- Phase 14-02: 0.25h (Settings persistence - theme preference model + DB layer + TypeScript types)
- Phase 14-03: 0.07h (ThemeProvider - React context, preload hooks, flash prevention)
- Phase 14-04: 0.08h (Settings UI theme selector - user-facing control with persistence)
- Phase 15-01: 0.16h (shadcn/ui setup - 11 core components, CSS variables, TypeScript aliases)
- Phase 15-02: 0.19h (component migration - TaskSettingsModal, ReviewModal, ApprovalForm, TaskModal, TaskForm to shadcn/ui)
- Phase 15-03: 0.08h (design system - color tokens, typography scale, font loading, WCAG AA compliance)
- Phase 16-01: 0.08h (Kanban board redesign - modern grid layout, status dots, hover effects, Tailwind styling)
- Phase 16-02: 0.15h (Header and navigation - AppHeader tabs, AgentMonitor split-pane, WorktreeManager grid, Settings redesign)
- Phase 17-01: 0.15h (Production build validation - CSS coverage, dark mode persistence, responsive layouts, accent color, visual regression checks)
- Phase 17-02: 0.18h (Accessibility audit - WCAG AA compliance, color contrast fixing, prefers-reduced-motion implementation, keyboard navigation)
- Phase 17.1-01: 0.13h (Production-safe IPC logging - safeInvoke wrapper, ProjectPicker instrumentation, App.tsx logging)
- Phase 17.1-02: 0.12h (Modern header with project dropdown and tab navigation - AppHeader redesign, App.tsx integration, tab routing)
- Phase 17.1-03: 0.06h (System accent color integration - accent color loading in ThemeProvider, CSS variable injection, theme change handling)
- Phase 17.1-04: 0.13h (Playwright visual regression testing - E2E framework, 10 test cases, baseline screenshots, responsive verification)
- Phase 18-01: 0.47h (ProjectConfig and ProjectState models - JSON serialization, save/load methods, cross-platform Path handling)
- Phase 18-02: 0.12h (Project Storage File I/O layer - 6 utility functions, graceful defaults, module integration with db/mod.rs)
- Phase 18-03: 0.10h (Maestro rebranding - tauri.conf.json, Cargo.toml, CLAUDE.md, README.md updated with consistent branding)
- Phase 18-04: 0.13h (IPC Handler Integration - create_project handler initializes .maestro folder on project creation)
- Phase 19-01: 0.07h (Extract Page-Level Components to Views - views directory with 5 orchestrator components, App.tsx updated)
- Phase 19-02: 0.001h (Organize Domain-Grouped Services Layer - centralized IPC wrapper + 6 domain services: task, project, settings, execution, connection)
- Phase 19-03: 0.08h (Organize Reusable Components into Domain-Specific Folders - 5 domain folders, barrel exports, 33 files with updated imports)
- Phase 19-04: 0.16h (Replace Scattered invoke() Calls with Service Layer - 31 IPC calls migrated, 10 components/providers updated, 7 service methods added)
- Phase 19-05: 0.09h (Organize Utils Layer - Hooks and Helpers - src/utils/{hooks,helpers} structure, 4 complex hooks in folders, 3 helpers consolidated, 63 files updated with new imports)
- Phase 20-01: 0.067h (Add TanStack Query Hooks to Task and Project Services - 10 task hooks + 7 project hooks + 2 query key factories, 349 lines added, automatic caching and optimistic updates)
- Phase 20-02: 0.043h (Add TanStack Query Hooks to Execution and Settings Services - 7 execution mutations + 3 settings hooks + 2 query key factories, 205 lines added, Sonner error handling)
- Phase 20-03: 0.055h (Audit and Extend Connection Service with TanStack Query Hooks - 5 new hooks, 176 lines, connection service complete)
- Phase 20-04: 0.048h (Migrate Core Components to TanStack Query Hooks - 3 components (App, ApprovalForm, ReviewModal), 121 new mutation hooks in task.service, Wave 2 begun)
- Phase 20-05: 0.067h (Migrate Kanban Workflow Components to TanStack Query Hooks - 3 components (SyncButton, TaskCard, TaskModal), 2 sync mutations added, 60+ lines state mgmt removed)
- Phase 20-06: 0.042h (Migrate Final Components and Hooks to TanStack Query - 3 components (FilePicker, ImportSettings, useRecentProjects), Wave 2 complete, 9/9 components migrated)
- Phase 20-07: 0.010h (Wave 3 Verification: Verify 0 direct invoke() calls remain, audit hook consistency, validate build, generate completion report - 37 total hooks verified, 2 regressions auto-fixed)
- Phase 21-01: 0.083h (Refactor Components Using Commands Object - 4 new file browser hooks in connection.service, refactored 5 files (ProjectList, ConnectionHeader, FilePicker, SettingsPage, useSshConnectionManager) to service hooks, eliminated all 15 direct commands usages, grep verified 0 remaining)

*Updated after each plan completion*
| Phase 19 P04 | 0.16 | 2 tasks | 12 files |
| Phase 19-05 P05 | 0.09 | 2 tasks | 63 files |
| Phase 20-01 P01 | 0.067 | 2 tasks | 2 files |
| Phase 20-02 P02 | 0.043 | 2 tasks | 2 files |
| Phase 20-03 P03 | 0.055 | 1 task | 1 file |
| Phase 20-04 P04 | 0.048 | 3 tasks | 4 files |
| Phase 20-05 P05 | 0.067 | 3 tasks | 5 files |
| Phase 20-06 P06 | 0.042 | 3 tasks | 5 files |
| Phase 20-07 P07 | 0.010 | 4 tasks | 2 files |
| Phase 21-01 P01 | 0.083 | 8 tasks | 6 files |
| Phase 22-01 P01 | 0.099 | 5 tasks | 2 files |
| Phase 23 P01 | 0.021 | 1 tasks | 2 files |
| Phase 23 P02 | 0.067 | 3 tasks | 6 files |
| Phase 24 P01 | 0.226 | 2 tasks | 4 files |
| Phase 24 P02 | 0.05 | 4 tasks | 8 files |
| Phase 24 P02 | 0.42 | 5 tasks | 12 files |
| Phase 25 P01 | 0.087 | 2 tasks | 7 files |
| Phase 25 P02 | 0.030 | 1 tasks | 1 files |
| Phase 25 P03 | 0.035 | 2 tasks | 3 files |
| Phase 25 P04 | 0.086 | 2 tasks | 3 files |
| Phase 26-agents-view P01 | 0.031 | 2 tasks | 5 files |
| Phase 26-agents-view P02 | 0.033 | 2 tasks | 2 files |
| Phase 27-worktrees-view P01 | 0.036 | 2 tasks | 4 files |
| Phase 27-worktrees-view P02 | 0.019 | 2 tasks | 3 files |
| Phase 27-worktrees-view P03 | 0.044 | 2 tasks | 2 files |
| Phase 28-zombie-cleanup-on-project-open P01 | 0.05 | 2 tasks | 5 files |
| Phase 29 P01 | 0.05 | 2 tasks | 3 files |
| Phase 29 P02 | 0.03 | 2 tasks | 10 files |
| Phase 30 P01 | 0.133 | 2 tasks | 6 files |
| Phase 30 P02 | 0.313 | 2 tasks | 12 files |
| Phase 30 P03 | 0.061 | 2 tasks | 4 files |
| Phase 31 P01 | 0.032 | 2 tasks | 3 files |
| Phase 31 P02 | 0.074 | 2 tasks | 1 files |
| Phase 32 P01 | 0.03 | 2 tasks | 4 files |
| Phase 32 P02 | 0.033 | 2 tasks | 5 files |
| Phase 32 P03 | 0.1 | 2 tasks | 9 files |
| Phase 32 P04 | 0.04 | 2 tasks | 5 files |
| Phase 32 P05 | 0.025 | 2 tasks | 15 files |
| Phase 33 P01 | 0.07 | 2 tasks | 4 files |
| Phase 33 P02 | 0.05 | 2 tasks | 3 files |
| Phase 33 P03 | 0.167 | 2 tasks | 6 files |
| Phase 34-remove-node-sidecar-implement-squash-merge-in-rust P01 | 0.033 | 2 tasks | 2 files |
| Phase 34 P02 | 0.45 | 2 tasks | 9 files |
| Phase 35 P01 | 0.3 | 2 tasks | 9 files |
| Phase 35 P02 | 0.033 | 2 tasks | 2 files |
| Phase 36 P01 | 0.207 | 1 tasks | 3 files |
| Phase 36 P02 | 0.033 | 1 tasks | 2 files |
| Phase 36 P02 | 0.370 | 2 tasks | 3 files |
| Phase 37 P01 | 0.083 | 2 tasks | 5 files |
| Phase 37 P02 | 0.050 | 2 tasks | 4 files |
| Phase 37 P03 | 0.042 | 2 tasks | 3 files |
| Phase 38 P01 | 0.078 | 2 tasks | 6 files |
| Phase 38 P02 | 0.133 | 2 tasks | 3 files |
| Phase 38 P03 | 0.067 | 2 tasks | 2 files |
| Phase 39-fix-ssh-terminal-session-switching P01 | 0.05 | 2 tasks | 2 files |
| Phase 39 P03 | 0.017 | 1 tasks | 1 files |
| Phase 39-fix-ssh-terminal-session-switching P02 | 0.05 | 2 tasks | 3 files |
| Phase 40 P00 | 0.05 | 1 tasks | 2 files |
| Phase 40 P01 | 0.077 | 2 tasks | 5 files |
| Phase 40 P02 | 0.046 | 1 tasks | 2 files |
| Phase 40 P03 | 0.055 | 2 tasks | 3 files |
| Phase 41-acp-agent-selection-discovery-system P01 | 0.067 | 1 tasks | 6 files |
| Phase 41 P02 | 0.032 | 2 tasks | 7 files |
| Phase 41 P03 | 0.033 | 1 tasks | 2 files |
| Phase 42 P01 | 0.061 | 3 tasks | 5 files |
| Phase 42 P02 | 0.030 | 1 tasks | 2 files |
| Phase 43-local-acp-session-manager P01 | 0.112 | 2 tasks | 3 files |
| Phase 43 P02 | 0.035 | 2 tasks | 4 files |
| Phase 44-db-schema-acp-ipc-handlers P01 | 0.072 | 3 tasks | 5 files |
| Phase 44-db-schema-acp-ipc-handlers P02 | 0.033 | 2 tasks | 2 files |
| Phase 45-agent-registry-fetch-caching P01 | 0.073 | 1 tasks | 3 files |
| Phase 45-agent-registry-fetch-caching P02 | 0.067 | 2 tasks | 3 files |
| Phase 46 P01 | 0.073 | 3 tasks | 4 files |
| Phase 46-frontend-agent-selector-spawn-flow P02 | 0.05 | 3 tasks | 3 files |
| Phase 47-frontend-agentactivitypanel P01 | 0.060 | 2 tasks | 7 files |
| Phase 47-frontend-agentactivitypanel P02 | 0.068 | 2 tasks | 6 files |
| Phase 47-frontend-agentactivitypanel P03 | 0.015 | 2 tasks | 1 files |

## Accumulated Context

### Decisions

From v1.1 planning:

- Phase 13 prioritized: Bug fixes must complete before UI work (clean foundation principle) ✓ COMPLETED
- Tailwind 4.1 + @tailwindcss/vite chosen: Official recommendation, 8kB bundle savings, native Vite integration ✓ IMPLEMENTED (14-01)
- shadcn/ui approach: Copy-paste workflow reduces coupling, theme-aware via CSS variables ✓ IMPLEMENTED (15-01)
- System-first theme: Follows OS theme preference (light/dark/auto), respects user's system settings ✓ VARIABLES READY (14-01)
- Design system via CSS variables: Dynamic accent color support (system theme integration) ✓ IMPLEMENTED (14-01)
- Theme preference persistence: AppSettings model + database layer ready for theme provider ✓ IMPLEMENTED (14-02)
- ThemeProvider architecture: React Context API with system theme detection + dual preload (frontend + Tauri) ✓ IMPLEMENTED (14-03)
- Settings UI theme control: ProjectSettingsModal integrated with theme selector, instant switching ✓ IMPLEMENTED (14-04)
- Component library via shadcn/ui: 11 core components installed (Button, Card, Input, Dialog, Badge, Select, Checkbox, Label, Textarea, Tabs, Popover) ✓ IMPLEMENTED (15-01)

Phase 15 Status:

- Phase 15-01: shadcn/ui foundation complete (components, CSS variables, TypeScript aliases) ✓ COMPLETE
- Phase 15-02: Component migration complete (TaskSettingsModal, ReviewModal, ApprovalForm, TaskModal, TaskForm to shadcn/ui) ✓ COMPLETE
- Phase 15-03: Design system complete (HSL color variables, typography scale, font loading, WCAG AA compliance) ✓ COMPLETE

Phase 16 Status:

- Phase 16-01: Kanban board redesign complete (grid layout, status dots, hover effects, animations) ✓ COMPLETE
- Phase 16-02: Header and navigation complete (multi-page routing, split-pane layouts) ✓ COMPLETE

Phase 17 Status:

- Phase 17-01: Production build validation complete (CSS coverage, dark mode, responsive layouts, visual regression analysis) ✓ COMPLETE
- Phase 17-02: Accessibility audit complete (WCAG AA compliance achieved, color contrast fixed, prefers-reduced-motion added) ✓ COMPLETE

Phase 18 Status:

- Phase 18-01: ProjectConfig and ProjectState models complete (JSON serialization with serde, save/load methods, defaults) ✓ COMPLETE
- Phase 18-02: Project Storage File I/O layer complete (6 utility functions, graceful defaults for new projects, cross-platform path handling) ✓ COMPLETE
- Phase 18-03: Maestro rebranding complete (tauri.conf.json, Cargo.toml, CLAUDE.md, README.md updated) ✓ COMPLETE
- Phase 18-04: IPC Handler Integration complete (create_project calls project_storage::create_project_maestro_folder) ✓ COMPLETE

Phase 18 Architecture Decisions:

- Use .maestro folder per-project for settings.json and state.json (instead of global database)
- Wrapper functions for clarity (export_config_to_settings, export_state_to_file) ✓ IMPLEMENTED (18-02)
- Graceful fallback pattern for new projects (return defaults if .maestro doesn't exist) ✓ IMPLEMENTED (18-02)
- Result<T, String> for all file I/O functions (Tauri IPC compatibility) ✓ IMPLEMENTED (18-02)
- [Phase 23]: navigate() discriminated union uses 'key' in target narrowing; same-tab setActiveTab guard prevents slideDirection clobbering
- [Phase 23]: App.tsx owns pendingTaskId consumption since TaskDetail is rendered there; pending entity ID pattern uses effectiveId override approach
- [Phase 24]: Inline DB logic in async IPC commands instead of calling create_project() to avoid State<'_> lifetime issues after .await points
- [Phase 24]: useCreateNewProject.onError does not toast (Create dialog shows inline errors); useCloneProject.onError does toast (git failures are server-side)
- [Phase 24]: Dual-dialog visibility pattern: main dialog hidden via open={open && !showDirPicker} while FilePicker sub-dialog is open, preserving form state
- [Phase 24]: Create dialog shows inline text-destructive errors; Clone dialog uses onError toast — split based on whether error is user-correctable
- [Phase 24]: Browse button uses active SSH connection from ConnectionContext (not hardcoded null) so remote projects browse via SSH
- [Phase 24]: git_init_project, clone_project, create_new_project IPC commands accept connection_id and dispatch to SSH session when remote
- [Phase 25]: Stub worktree_handlers.rs and spawn/resume execution functions with todo!() to keep cargo check green during schema/model migration — Plan 03/04 will rewrite
- [Phase 25]: WorktreeStatus and PoolStatus fully removed from codebase; get_pool_status return type changed to Vec<WorktreeWithStatus> to signal Plan 03 intent
- [Phase 25]: Use tokio::process::Command for all local git operations to avoid blocking the async runtime
- [Phase 25]: get_worktree_status_local does not fail on non-zero exit to handle edge cases like detached HEAD gracefully
- [Phase 25]: git2::Repository inside tokio::task::spawn_blocking for get_worktree_diff; orphan/zombie detection by cross-referencing disk vs DB state; auto-delete stale DB rows in list_worktrees_with_status
- [Phase 25]: spawn_agent_execution and resume_agent_execution call create_worktree_for_task on entry and delete_worktree_for_task in finalization; error paths delete DB row best-effort
- [Phase 25]: list_executions_with_task_info uses LEFT JOIN worktrees so executions with no active worktree still appear after completion cleanup
- [Phase 26-agents-view]: AgentsView owns TanStack Query call; AgentMonitor is a pure display component receiving props
- [Phase 26-agents-view]: detachTerminal .catch(() => {}) suppresses errors when PTY already ended on task completion
- [Phase 26-agents-view]: DeadSessionTerminal never calls attachTerminal/detachTerminal; uses write-only xterm.js with disableStdin:true and writes terminal_output from DB on mount
- [Phase 27-01]: useWorktreesQuery polls at 5s not 2s — worktree status changes less frequently than execution status; reduces git subprocess overhead
- [Phase 27-01]: diff_stat_map populated in same parallel tokio::spawn as status_map — single spawned closure runs git status and git diff --shortstat per worktree
- [Phase 27-02]: WorktreeManager accepts worktrees as props (pure display, matching AgentMonitor pattern)
- [Phase 27-02]: Filter logic: Active=agent_status running, Modified=non-empty git_status, Idle=not running and clean
- [Phase 27-03]: AlertDialogTrigger uses render prop (base-ui pattern) not asChild (Radix); projectId threaded as explicit prop to WorktreeManager; parseDiffString returns DiffFileWithName[] mapped to one DiffViewer per file
- [Phase 28-zombie-cleanup-on-project-open]: Scoped closure pattern for Rust SQLite query to satisfy borrow checker (conn + stmt lifetime)
- [Phase 28-zombie-cleanup-on-project-open]: Silent mutation: onError logs to console but no toast — zombie cleanup is background housekeeping
- [Phase 29]: DiffViewer uses useTheme() for component-level theme resolution; WorktreeManager checks diffLoading first to avoid empty state flash; append_terminal_output uses SQL subquery for UPDATE portability
- [Phase 30]: Filter state lifted to view (AgentsView/WorktreesView) — display components are pure, matching Phase 26 AgentMonitor pattern
- [Phase 30]: canonicalize() applied at IPC boundary in spawn/resume_agent_execution and create_worktree_for_task to fix git repo path bug
- [Phase 30]: Schema V4: execution_logs.task_id nullable (inline FK) to support task-free interactive PTY sessions; create_worktree IPC uses origin_branch + new_branch_name; AgentMonitor selects by execution.id (not task_id) to handle null task_id
- [Phase 30]: Select onValueChange null-coalesce: (v) => setState(v ?? '') because base-ui Select passes string | null
- [Phase 31]: Use project.connection_id (not project.id) as SSH session map key — connection_id is the FK to ssh_connections which is the actual key used on session insert
- [Phase 31]: Shell single-quote all path arguments in SSH commands to handle paths with spaces correctly
- [Phase 31]: parse_worktree_list made pub to allow reuse in remote::list_remote_worktrees without code duplication
- [Phase 31]: Use ? instead of unwrap_or_else for SSH connection in create/delete IPC — fail explicitly to avoid silently operating on wrong path for remote projects
- [Phase 31]: Gate create_dir_all on !is_remote in create_worktree IPC — SSH projects create parent dirs automatically via git worktree add
- [Phase 32]: Use task_id FK join for worktree lookup in review handlers (V5 schema, no status column)
- [Phase 32]: Replace .expect() with map_err+? in all three project insertion sites
- [Phase 32]: poll_remote_log extracted as shared function eliminating 80 lines of duplicated SSH log-polling code between stream_remote_output and attach_remote_stream_listener
- [Phase 32]: resume_agent_execution delegates to spawn_agent_execution with swapped parameter order (resume: task_id second, spawn: project_id second)
- [Phase 32]: get_project_with_git_conn uses ? for both DB lookup and SSH session resolution — call sites needing fallback keep two-step approach
- [Phase 32]: update_task uses Vec<Box<dyn ToSql>> for dynamic params; conn must be mut for transaction(); re-lock after commit to read back
- [Phase 32]: finalize_successful_merge DB writes stay intentionally split across lock acquisitions (async git cleanup between steps)
- [Phase 32]: shell_quote pub so project_handlers.rs can import from crate::git::remote; standardizes SSH path escaping
- [Phase 32]: Zeroizing<String> wraps SSH passwords in AppState and RemoteSshSession; caller API unchanged (pass plain String, wrap internally)
- [Phase 32]: Reconnection race fixed: hold state lock while setting Connecting, drop before async connect(); concurrent callers wait on Connecting state
- [Phase 32]: PTY take_writer() called once in spawn; write_input uses stored writer field — no OS fd clone per keystroke
- [Phase 32]: AppError removed: all IPC handlers return Result<T, String>; error.rs kept as empty comment-only module
- [Phase 32]: ProjectConfigRequest kept as separate struct (not aliased) — type aliases cannot carry #[derive(TS)] / #[specta(export)]
- [Phase 32]: upsert_imported_tasks extracted as private fn: both GitHub/Jira sync functions share identical DB upsert logic
- [Phase 32]: stop_remote_stream now calls kill_remote_process (was a no-op Ok(()) previously)
- [Phase 33]: INSERT OR REPLACE handles UNIQUE(task_id) constraint on task_reviews — CASCADE-deletes old review_comments automatically
- [Phase 33]: finalize_successful_merge resolves git_conn internally (no repo_path param) — cleaner separation of concerns
- [Phase 33]: Branch deletion stays as inline tokio::process::Command (non-fatal) since git dispatcher has no delete_branch
- [Phase 33]: register_project_in_db uses IS ? for nullable column comparison to fix SQLite NULL semantics bug
- [Phase 33]: finalize_ssh_connection early-return path keeps inline DB update; only fresh-auth path uses the helper
- [Phase 33]: get_worktree_diff uses JOIN projects p ON p.id = w.project_id — one DB round-trip instead of two sequential lock acquisitions
- [Phase 33]: error.rs deleted (comment-only stub); mod error removed from lib.rs — empty modules add noise with no benefit
- [Phase 33]: All Rust diagnostic output uses log::info!/warn!/debug! — zero println!/eprintln! remain in the backend
- [Phase 34-remove-node-sidecar-implement-squash-merge-in-rust]: squash_merge_to_main is pub but not dispatched through GitConnection — worktrees are always local even for remote projects, so squash merge always runs on local repo path
- [Phase 34-remove-node-sidecar-implement-squash-merge-in-rust]: Do not check output.status.success() after git merge --squash --no-commit — non-zero exit is expected on conflicts, handled by subsequent git status --porcelain
- [Phase 34-remove-node-sidecar-implement-squash-merge-in-rust]: MergeOutcome removed from review_handlers.rs — no longer needed after eliminating sidecar JSON parsing; type remains in models/merge_outcome.rs for deletion in Plan 02
- [Phase 34]: retry_execution and resume_agent_execution updated to reset execution log status rather than calling the deleted spawn_agent_execution IPC
- [Phase 34]: useSpawnExecutionMutation deprecated with informative throw; boardStore.executeTask throws informative error — preserves API surface for caller discovery
- [Phase 35]: run_git_in_dir dispatcher handles local TokioCommand and remote SSH execute_command — follows existing GitConnection pattern
- [Phase 35]: DiffTarget enum: Head=git diff HEAD (uncommitted), Branch(name)=git diff --unified=6 origin/{name}..HEAD (full branch diff)
- [Phase 35]: list_worktrees_with_status runs status+diff_stat for both local and remote worktrees (removed is_remote gate)
- [Phase 35]: Use onPressedChange (base-ui Toggle API) instead of onClick for ToggleGroupItem pressed state control
- [Phase 35]: diffBranch pre-populated from selectedWorktree.branch_name via useEffect; Branch mode always attempts diff even with clean working tree
- [Phase 36]: status field is optional on DiffFileWithName — parseDiffString always sets it, but type flexibility preserved for manual construction
- [Phase 36]: computeFileStats self-guards against +++ / --- lines — does not assume they are pre-stripped by the caller
- [Phase 36]: Always use DiffTarget::Head in WorktreeManager — diff target toggle removed; branch diff added unnecessary UI complexity without sufficient value
- [Phase 36]: Module-level DIFF_TARGET_HEAD constant outside component avoids query key object recreation on every render (stable reference)
- [Phase 36]: Split selection reset into two effects: worktreeId clears immediately; diffFiles auto-selects first only when nothing selected — prevents background refetch from bouncing user off chosen file
- [Phase 36]: useWorktreeDiffQuery gets refetchInterval:5000 to match worktree list polling so diff body stays live
- [Phase 36]: File list items use single flex row with inline stats (no second row for +/- stats)
- [Phase 37]: Schema V6: base_branch TEXT nullable column added via drop-and-recreate migration; AheadBehind uses named struct for specta TS compatibility; create_worktree_for_task stores NULL; rev-list failure yields None silently
- [Phase 37]: WorktreeCard accesses ahead_behind.ahead and .behind as named struct fields not tuple index
- [Phase 37]: parseDiffStat copied into WorktreeCard.tsx for self-contained card; STATUS_FILTERS/StatusFilter defined locally in WorktreesView
- [Phase 37]: Delete dialog uses pendingDeleteId separate from selectedWorktreeId to avoid coupling card selection and delete trigger
- [Phase 37]: Slide container pattern: outer overflow-hidden, inner w-[200%] flex row, each screen w-1/2, -translate-x-1/2 on selection
- [Phase 37]: WorktreeDiffPanel renders null when worktree===null (mounted for CSS slide animation, invisible until worktree selected)
- [Phase 37]: Unified/split toggle moved to action bar in WorktreeDiffPanel — single consistent control position, per-file header shows filename+status+stats only
- [Phase 38]: Write patch to temp file before git apply --cached — run_git_in_dir has no stdin support
- [Phase 38]: discard_worktree_changes: git reset HEAD then git checkout -- two-step required for staged files
- [Phase 38]: CheckboxPrimitive.Root used directly (not Checkbox wrapper) to access indeterminate prop for tri-state file checkboxes
- [Phase 38]: FileTree checkedFiles/onToggleFile props optional; checkboxes only render when both provided — backward compatible
- [Phase 38]: Use hunk summary strip (fallback) above DiffView — @git-diff-view/react has no dedicated hunk header render slot
- [Phase 38]: AlertDialogTrigger/PopoverTrigger use render= prop (base-ui pattern); hunk selection props skipped when whole file staged
- [Phase 39-fix-ssh-terminal-session-switching]: SshPtyHandle.history changed from Arc<Mutex<Vec<String>>> to Arc<Mutex<String>>; append_to_history maintains clear-screen trimming and 512 KB cap invariant
- [Phase 39-fix-ssh-terminal-session-switching]: attach_terminal SSH live sessions start at pos=hist.len() (no history replay); dead sessions read terminal_output from DB by log_id; history persisted to DB on process_ended
- [Phase 39]: tryAttach() moved inside rAF after fitAddon.fit() — SIGWINCH fires before attach, programs repaint into blank xterm buffer
- [Phase 39]: terminal.write('\x1b[2J\x1b[H') cosmetic guard inside rAF clears xterm viewport before attachTerminal call
- [Phase 39-fix-ssh-terminal-session-switching]: AtomicBool chosen over tokio::sync::watch for cancel token — watch::Receiver::changed().await is async and cannot be polled inside spawn_blocking; AtomicBool with Ordering::Relaxed is directly checkable from blocking threads
- [Phase 39-fix-ssh-terminal-session-switching]: Two-phase lock pattern in shutdown hook: collect all tokio Mutex snapshots first, drop async guards, then write via std::sync::Mutex — std::sync::MutexGuard<Connection> never crosses an .await point
- [Phase 40]: Wave 0 test stubs intentionally fail — they establish behavioral contracts for Plan 03 implementors
- [Phase 40]: Tauri event mock pattern: mutable mockListeners registry + vi.mock(@tauri-apps/api/event) + emitMockEvent helper for synchronous act()-wrapped event simulation in hook tests
- [Phase 40]: spawn_heartbeat_task lives in session.rs (same module) to access private fields: state, reconnect_attempts, session_password
- [Phase 40]: Heartbeat probe uses execute_command('true') — lightweight, no output, always exits 0 on live connection; is_transient_error gate prevents retrying auth failures
- [Phase 40]: AppHandle stored in AppState for Tauri event emission from background tasks (Plan 40-01); passed from app.handle().clone() in main.rs setup
- [Phase 40]: Arc<AppState> threaded into spawn_heartbeat_task for PTY cleanup access to both ssh_pty_sessions and db
- [Phase 40]: useConnectionHealth null guard prevents listener registration for local projects; Promise.all cleanup satisfies T-40-08 mitigate; backdrop placed after main inside currentProject branch
- [Phase 41-01]: Use #[serde(tag = "direction")] on MaestroRpcMessage to distinguish Request/Response without untagged ambiguity pitfall
- [Phase 41-01]: 16 MB MAX_MESSAGE_SIZE guard in read_message before body buffer allocation — T-41-01 DoS mitigation
- [Phase 41-01]: maestro-server placeholder (fn main() {}) created in this plan so cargo check --workspace passes; Plan 03 overwrites with real implementation
- [Phase 41]: ACP Client trait is #[async_trait::async_trait(?Send)] — verified from SDK source v0.10.4; request_permission and session_notification are the only required methods
- [Phase 41]: MaestroAcpClient stubs: request_permission returns Err(method_not_found()), session_notification returns Ok(()) — T-41-03 mitigated, no filesystem access in Phase 41
- [Phase 41]: [Phase 41-03]: Use tokio current_thread flavor + LocalSet in maestro-server main so Phase 42 can use spawn_local for !Send ACP Client futures
- [Phase 41]: [Phase 41-03]: Add tokio-util with compat feature explicitly (not just transitively) so Phase 42 can use TokioAsyncReadCompatExt/TokioAsyncWriteCompatExt for stdio bridging
- [Phase 42]: Rc<tokio::sync::Mutex<Stdout>> for stdout: Rc because Client is ?Send, Mutex needed for await-safe locking in send_response
- [Phase 42]: PermitResponse uses existing PermissionResponse struct as ServerRequest variant — no new type needed; serializes as permit_response via snake_case serde tag
- [Phase 42]: T-42-01 cwd validation in create_terminal: reject '..' components and non-existent paths before subprocess spawn
- [Phase 42]: Import Agent trait explicitly in main.rs scope — Rust requires trait in scope for ClientSideConnection method calls
- [Phase 42]: Use .client_capabilities() not .capabilities() on InitializeRequest — correct ACP SDK v0.10.4 method name
- [Phase 42]: PermitResponse dispatch maps bool allowed to RequestPermissionOutcome: true->Selected(allow_once), false->Cancelled
- AcpProcess.reader_cancel_tx is Option<oneshot::Sender<()>> so it can be .take()-ed without Clone requirement
- Session inserted into acp_sessions BEFORE reader task spawned — ensures IPC handlers see it immediately after spawn_acp_process returns
- BufWriter::flush() called after every write_message — CRITICAL; server would not receive message without explicit flush
- session_id derived from log_id as format!("session-{}", log_id) — ties ACP protocol session to DB row without extra state
- cancel_acp_session sends CancelRequest best-effort before dropping AcpProcess — server notified of clean shutdown even if process already gone
- DB lock dropped before async spawn_acp_process call — avoids holding std::sync::MutexGuard across .await
- spawn_acp_session INSERT uses execution_mode='acp' and agent_id columns directly (v11 schema)
- send_acp_prompt and respond_acp_permission are dedicated commands with typed params (no message_type dispatch)
- ExecutionWithTask.execution_mode and agent_id are Option<String> for LEFT JOIN backward compat
- structured_updates never cleared between flushes — overwrite semantics mean column always stores full accumulated list for dead-session replay
- Final flush placed before acp_sessions.lock().await.remove() — ensures data written before session entry removed from map
- Lock-drop-before-await: RegistryCacheEntry guard released before CDN fetch to prevent holding tokio Mutex across .await point
- RegistryCacheEntry not TS-exported (no Type derive): Instant is not serializable; RegistryResponse is the IPC boundary type
- current_binary_target_key() returns empty string on unknown platforms; resolve_distribution treats empty key as no match falling through to uvx
- fetch_agent_registry delegates entirely to acp::registry::fetch_or_return_cached — handler is a thin IPC boundary with no logic
- resolve_agent_launch_command holds cache lock only during the lookup — no await across the guard
- AcpRegistry not in bindings.ts: tauri-specta only exports types reachable from registered IPC command signatures; RegistryResponse is the IPC boundary type
- useAgentRegistryQuery gates fetch on enabled=open to avoid CDN calls on every AgentsView mount
- 5-minute staleTime in useAgentRegistryQuery mirrors backend registry TTL to prevent redundant IPC calls
- AgentSelectorDialog cwd uses WorktreeWithStatus.path (absolute path) not worktree.id — spawn_acp_session takes cwd: string
- Spawn Agent button placed in right group of action bar; existing search+filter controls stay in left group
- Badge always renders for all sessions (not gated on !task_name) — every session gets a type label
- PTY dialog renamed to 'New Terminal Session' to differentiate from 'Spawn ACP Agent' dialog
- [Phase 47-01]: SessionUpdate types defined frontend-only (not Rust-generated) — backend emits serde_json::Value; TS types narrow at hook consume site
- [Phase 47-01]: activityReducer exported from useAcpActivity.ts as single canonical accumulation path for both live and dead sessions; Plan 02 uses useReducer + load_from_db dispatch
- [Phase 47-01]: Unknown sessionUpdate variants silently ignored via default: return newState in processEvent — T-47-02 threat mitigation
- [Phase 47-01]: useStructuredOutputQuery uses staleTime: Infinity — dead sessions are immutable once completed
- [Phase 47-02]: useSelectedProject() from projectStore used for projectId in AgentActivityPanel — ConnectionContext has no projectId field; plan's useConnection() reference was incorrect
- [Phase 47-02]: Dead session replay uses useReducer(activityReducer, INITIAL_ACTIVITY_STATE) + load_from_db dispatch — single canonical accumulation path for live and dead sessions
- [Phase 47-02]: AcpTerminalPanel uses listen() on acp://terminal-output/{logId} not attachTerminal IPC — ACP sessions have no PTY entry in pty_sessions
- [Phase 47-02]: Terminal toggle button hidden for dead sessions — no persisted terminal output for completed ACP sessions

### v1.5 Roadmap Notes

- Phase 45 (Registry) is independent of Phases 42-43 and can be developed in parallel
- Phase 46 depends on both Phase 44 and Phase 45 — both must complete before frontend spawn flow
- Phases 47 and 48 both depend on 46 and can be developed in parallel with each other
- Phase 49 (Dispatcher) depends on 47 and 48 — final integration phase for the milestone

### Pending Todos

1. **Fix get_worktree_diff and list_worktrees for remote projects** — `get_worktree_diff` uses git2 locally (broken for SSH projects); per-worktree status/diff-stat in `list_worktrees` is silently skipped for remote. Both need SSH dispatch. Files: `worktree_handlers.rs:103-137,225`, `git/remote.rs`

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260330-khs | move spawn agent button to top of list and rename to New Session | 2026-03-30 | b9ec20f | [260330-khs-move-spawn-agent-button-to-top-of-list-a](./quick/260330-khs-move-spawn-agent-button-to-top-of-list-a/) |
| 260330-tb8 | fix Worktrees and Agents view bugs (cleanup modal, stale branches, delete/reconnect, interactive PTY) | 2026-03-30 | 91c459b | [260330-tb8-fix-worktrees-and-agents-view-bugs](./quick/260330-tb8-fix-worktrees-and-agents-view-bugs/) |
| 260331-d7x | search in backend code usage of git commands and list them | 2026-03-31 | — | [260331-d7x-search-in-backend-code-usage-of-git-comm](./quick/260331-d7x-search-in-backend-code-usage-of-git-comm/) |
| 260401-csx | Revert Rust logging from log crate back to console prints | 2026-04-01 | 2b4776d | [260401-csx-revert-rust-logging-from-log-crate-back-](./quick/260401-csx-revert-rust-logging-from-log-crate-back-/) |
| 260401-is7 | Add unified/split view toggle in git diff pane | 2026-04-01 | aad4dfd | [260401-is7-add-unified-and-split-view-toggle-in-git](./quick/260401-is7-add-unified-and-split-view-toggle-in-git/) |
| 260401-tau | Fix 3 post-phase-37 UI issues: gate diff pane on dirty status, slide action bar, center branch name | 2026-04-01 | 7eb166b | [260401-tau-fix-3-post-phase-37-ui-issues-diff-pane-](./quick/260401-tau-fix-3-post-phase-37-ui-issues-diff-pane-/) |
| 260402-ctz | Add group/grid toggle to worktrees view action bar | 2026-04-02 | 72c638b | [260402-ctz-in-the-worktrees-view-add-a-group-toggle](./quick/260402-ctz-in-the-worktrees-view-add-a-group-grid-/) |
| 260402-d3x | add branch deletion checkbox to worktree removal modal | 2026-04-02 | db61a9b | [260402-d3x-add-branch-deletion-checkbox-to-worktree](./quick/260402-d3x-add-branch-deletion-checkbox-to-worktree/) |
| 260407-eu5 | Fix Phase 38 UI issues: folder tri-state checkboxes, chunk header inline checkbox, diff panel full height | 2026-04-07 | 3427db9 | [260407-eu5-fix-phase-38-ui-issues-folder-tri-state-](./quick/260407-eu5-fix-phase-38-ui-issues-folder-tri-state-/) |
| 260408-cee | Style terminal with mono font and app background for better integration | 2026-04-08 | 42e44d5 | [260408-cee-style-terminal-with-mono-font-and-app-ba](./quick/260408-cee-style-terminal-with-mono-font-and-app-ba/) |
| 260408-g78 | reconnect failed session should reuse existing parameters not prompt for branch selection | 2026-04-08 | dc81db5 | [260408-g78-reconnect-failed-session-should-reuse-ex](./quick/260408-g78-reconnect-failed-session-should-reuse-ex/) |
| 260408-guc | reconnect removes failed session instead of leaving duplicate in sidebar | 2026-04-08 | b6f7894 | [260408-guc-reconnect-removes-failed-session-instead](./quick/260408-guc-reconnect-removes-failed-session-instead/) |
| 260408-h39 | remove all eprintln! from Rust backend (178 occurrences, 14 files) | 2026-04-08 | b0b2a23 | [260408-h39-remove-all-eprintln-for-agent-session-in](./quick/260408-h39-remove-all-eprintln-for-agent-session-in/) |
| 260408-il9 | fix CSP violations blocking Google Fonts and Tauri IPC custom protocol | 2026-04-08 | b10e8b9 | [260408-il9-fix-csp-violations-blocking-google-fonts](./quick/260408-il9-fix-csp-violations-blocking-google-fonts/) |
| 260408-r6o | Fix broken session name search + rename placeholder in agents view | 2026-04-08 | fb2a172 | [260408-r6o-fix-broken-session-name-search-rename-pl](./quick/260408-r6o-fix-broken-session-name-search-rename-pl/) |
| 260408-s08 | new session dialog: select worktree instead of branch, refresh list on open | 2026-04-08 | 3eee4da | [260408-s08-new-session-dialog-select-worktree-inste](./quick/260408-s08-new-session-dialog-select-worktree-inste/) |
| 260409-fnx | replace label by session name and wire it to storage and display | 2026-04-09 | 17a42eb | [260409-fnx-replace-label-by-session-name-and-wire-i](./quick/260409-fnx-replace-label-by-session-name-and-wire-i/) |
| 260410-amc | add Maestro logo (public/maestro-logo.png) to project picker startup screen above app name | 2026-04-10 | e1623f5 | [260410-amc-integrate-public-maestro-logo-png-gracef](./quick/260410-amc-integrate-public-maestro-logo-png-gracef/) |
| 260410-awn | enhance task execution: named session (-n flag), task description injection, InProgress status on spawn | 2026-04-10 | 23e2473 | [260410-awn-enhance-task-execution-named-session-inj](./quick/260410-awn-enhance-task-execution-named-session-inj/) |
| 260416-sir | replace dismiss button with cancel/abort/leave button that navigates back to connection screen on SSH connection lost backdrop | 2026-04-16 | 43743c5 | [260416-sir-replace-dismiss-button-with-cancel-abort](./quick/260416-sir-replace-dismiss-button-with-cancel-abort/) |

### Blockers/Concerns

None.

### Roadmap Evolution

- Phase 17.1 inserted after Phase 17: Critical UI Fixes (URGENT) - Fix production folder selection, implement slick UX patterns from exemple/ (not pixel-perfect copy), use system accent color, verify with Playwright screenshots
- Phase 18 added: Maestro Folder Architecture & Rebranding - Migrate from database-centric to project-local .maestro folder storage; rebrand from "GSD Orchestrator" to "Maestro"
- Phase 19 added: Frontend Architecture Refactoring - Reorganize src/ to follow standard project structure with views/, services/, and grouped components
- Phase 20 added: Refactor Frontend to use TanStack Query - Replace direct invoke() calls with TanStack Query hooks for data fetching, caching, and mutations
- Phase 21 added: Refactor Components Using Commands Object - Refactor any component using directly "commands" object from @src/types/bindings.ts to use service hooks instead
- Phase 22 added: Auto-remove Stale Projects - get_connection_projects made async, drops db lock before path validation, collect_stale_project_ids helper validates local (std::fs) and SSH (test -d) paths
- Phase 23 added: Add in-app routing for deep linking to specific screens
- Phase 24 added: Improve project picker screen — auto-detect and init git on select, Clone Project button (git URL + target path), Create Project button (name + target path + git init)
- Phase 25 added: Backend Overhaul — worktree/execution backend rewrite for v1.3 Agents & Worktrees milestone
- Phase 26 added: Agents View — AgentsView with xterm.js terminal, active + history list, split-pane layout
- Phase 27 added: Worktrees View — WorktreesView with git diff panel, status filtering, zombie detection
- Phase 28 added: Zombie Cleanup on Project Open — auto-cleanup orphaned worktrees on project load
- Phase 29 added: v1.3 Agents & Worktrees view polish and bug fixes
- Phase 31 added: Fix remote SSH worktree bugs: git ops, origin branch detection, and worktree path filtering
- Phase 30 added: v1.3 post-testing UI and worktree bug fixes
- Phase 32 added: Backend code quality: fix all findings from code review
- Phase 33 added: tauri backend code review and refactoring for maintainability DRY SOLID KISS
- Phase 34 added: Remove Node.js sidecar — implement squash merge in Rust (local + SSH)
- Phase 36 added: Redesign the diff pane in the worktrees view (uncommitted-only default, unified/split toggle, file selector)
- Phase 37 added: Redesign the worktrees view with card grid and slide-in diff panel
- Phase 38 added: Add git commit features to the diff view — file selection with tri-state checkboxes, revert/shelve/commit actions, block-level staging from diff pane
- Phase 39 added: Fix SSH terminal session switching — SIGWINCH-based live repaint, clear-signal-trimmed history buffer (String with `\x1b[2J` boundary trimming + byte-cap fallback), DB snapshot on session end and app close, dead session recovery from DB snapshot
- Phase 40 added: SSH disconnection handling — heartbeat keepalive, full-screen reconnect backdrop with exponential backoff, PTY session cleanup on connection loss, Tauri event emission for connection state changes
- Phase 41 added: ACP Agent Selection & Discovery System — agent detection (PATH/user folder/project folder), default agent in settings, session type selection (agent/terminal), per-task agent assignment
- Phases 42-49 added: v1.5 ACP Integration milestone — maestro-server activation, local session manager, DB schema v11 + IPC, registry fetch/caching, agent selector UI, activity panel, permission dialog, dual-mode dispatcher

## Session Continuity

Current session: 2026-04-23 (Phase 47 Plan 03 executed)
Completed: 47-03-PLAN.md — REQUIREMENTS.md ACTIVITY-02 marked complete, description updated to AcpTerminalPanel toggle-panel design; ROADMAP.md SC#2 confirmed correct
Status: Phase 47 complete — all 3 plans done
Session timestamp: 2026-04-23T01:09:32Z

---

**v1.5 MILESTONE STATUS: IN PROGRESS**
**Phase 47 STATUS: COMPLETE**
