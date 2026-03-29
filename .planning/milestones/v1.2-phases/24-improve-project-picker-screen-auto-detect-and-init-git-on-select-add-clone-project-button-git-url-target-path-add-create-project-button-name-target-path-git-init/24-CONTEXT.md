# Phase 24: Improve Project Picker Screen - Context

**Gathered:** 2026-03-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Enhance the existing project picker screen with three new capabilities:
1. **Auto-detect git on select** — when a folder with no `.git` repo is selected via the existing FilePicker, automatically run `git init` before creating the project in Maestro
2. **Clone Project** — a new dialog with a form to clone a remote git repo by URL into a chosen target path
3. **Create Project** — a new dialog with a form to create a new project folder (with parent dir + folder name), run `git init`, and add it to Maestro

The existing "Select New Project" file browser remains. The three operations are surfaced as three footer buttons in the projects panel.

</domain>

<decisions>
## Implementation Decisions

### Non-git folder behavior
- When a folder with no `.git` is selected via FilePicker: **auto-init git silently** — run `git init` automatically before `create_project`. No confirmation dialog.
- Git status is NOT shown in the FilePicker while browsing — check only at selection time.

### Button placement
- Footer becomes a row of 3 buttons: **[Select Existing] [Clone] [Create]**
- "Select Existing" replaces the current "Select New Project" button (same behavior — opens FilePicker)
- Clone and Create each open their own **modal dialog** (same pattern as the existing FilePicker Dialog)

### Clone Project form
- Inputs: **git URL** (text input) + **target path** (text input + Browse button that opens FilePicker to select parent directory)
- No branch field — clone default branch only
- Progress UX: **spinner while cloning, dismiss dialog on success, show result via toast**. No raw git output shown.
- Target path browsing: reuses the existing FilePicker component to pick a parent directory; user types or sees the resulting path in the text input

### Create Project form
- Inputs: **two separate fields** — "Parent directory" (text input + Browse button) + "Folder name" (text input)
- No display name separate from folder name — the folder name IS the project name in Maestro
- Maestro concatenates parent dir + folder name to get the full path, creates the directory, runs `git init`, then calls `create_project`
- If the target directory already exists: **fail with a clear inline error** (not a toast) — "Directory already exists. Choose a different path or use Select Existing."

### Claude's Discretion
- Exact button sizing and visual weight within the 3-button footer (primary vs outline vs secondary variants)
- Whether Clone/Create dialogs share a single `<Dialog>` component with swappable content or are independent Dialog instances
- Error handling for invalid git URLs in Clone (inline validation vs server-side error)
- Whether the Browse button in Clone/Create dialogs opens a connection-aware FilePicker (same SSH support) or local-only

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing project picker components
- `src/views/ProjectPickerView.tsx` — Page-level wrapper, entry point
- `src/components/project-picker/ProjectPicker.tsx` — Two-panel slide layout (Connections ↔ Projects)
- `src/components/project-picker/ProjectList.tsx` — Projects panel: recent list, FilePicker dialog, button footer
- `src/components/project-picker/ProjectsListLayout.tsx` — Layout wrapper with header + scrollable list + footer button
- `src/components/project-picker/FilePicker.tsx` — Directory browser (local + SSH)

### Existing IPC layer
- `src-tauri/src/ipc/project_handlers.rs` — `create_project` command (add git-init + clone commands here or alongside)
- `src/services/project.service.ts` — `useCreateProject` mutation hook (extend or add new hooks for clone/create)

### Existing git module
- `src-tauri/src/git/mod.rs` — Git operations dispatcher (local vs SSH); add `git_init` and `git_clone` functions here

### Design system patterns
- `src/components/project-picker/ProjectListItem.tsx` — Item pattern (button + hover actions)
- `src/ui/dialog.tsx` — shadcn/ui Dialog (used by existing FilePicker modal)

No external specs — requirements fully captured in decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `FilePicker` component: already handles both local and SSH directory browsing — reuse as the Browse picker in Clone/Create dialogs
- `Dialog` + `DialogContent` from `@/ui/dialog`: existing pattern for modal overlays (FilePicker already uses this)
- `useCreateProject` mutation: existing hook in `project.service.ts` for adding a project to the DB
- `create_project` Rust handler: creates DB record + initializes `.maestro/` folder — extend to accept an `init_git` flag

### Established Patterns
- Three-button footer: `ProjectsListLayout` currently has a single primary button in the footer — extend `onSelectNewClick` prop pattern or replace with a more flexible footer slot
- Loading state: `projectLoading` / `disabled` already threaded through the component tree
- Toast feedback: `sonner` toasts used throughout (`toast.success`, `toast.error`)
- Compact design: `h-7`, `text-xs`, `p-3` spacing patterns from design system

### Integration Points
- `ProjectsListLayout.tsx:footer` — Replace single button with a 3-button row; may need a new prop (e.g., `footerContent: ReactNode`) or dedicated Clone/Create button props
- `ProjectList.tsx` — Add `showCloneModal` and `showCreateModal` state alongside existing `showFilePickerModal`; add two new Dialog instances
- `src-tauri/src/git/mod.rs` — Add `git_init(path)` and `git_clone(url, target_path)` functions (local + SSH variants)
- `src-tauri/src/ipc/project_handlers.rs` — Add `clone_project(url, target_path)` and `create_project_with_init(parent_dir, folder_name)` IPC commands

</code_context>

<specifics>
## Specific Ideas

- The 3-button footer layout: `[Select Existing] [Clone] [Create]` — all equal-width or primary/secondary weighting is Claude's discretion
- "Select Existing" keeps the same FilePicker behavior as today's "Select New Project"
- The auto-git-init on FilePicker selection should be transparent to the user — no UI change, just runs `git init` in the background before `create_project`

</specifics>

<deferred>
## Deferred Ideas

- Branch selection in Clone (clone non-default branch) — deferred, default branch only for now
- Template/starter support in Create — not in scope
- SSH-aware Clone/Create (cloning into remote servers) — scope unclear, defer; local only for v1

</deferred>

---

*Phase: 24-improve-project-picker-screen-auto-detect-and-init-git-on-select-add-clone-project-button-git-url-target-path-add-create-project-button-name-target-path-git-init*
*Context gathered: 2026-03-28*
