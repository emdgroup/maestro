# Phase 24: Improve Project Picker Screen - Research

**Researched:** 2026-03-28
**Domain:** Tauri 2 (Rust) + React/TypeScript — git operations, IPC commands, modal dialogs
**Confidence:** HIGH

## Summary

This phase adds three capabilities to the project picker: auto-`git init` when a non-git folder is selected, a Clone Project dialog (URL + target path), and a Create Project dialog (parent dir + folder name + auto `git init`). All three share the same backend pattern: a new Rust IPC command that runs a `git` subprocess, then calls the existing `create_project` DB+`.maestro` init logic.

The frontend work is purely additive: the footer of `ProjectsListLayout` gains two more buttons, and `ProjectList` gets two more Dialog instances that embed simple forms. The existing `FilePicker` component is reused as a directory-picker inside both dialogs. The `api` proxy + TanStack Query `useMutation` pattern applies cleanly to the two new IPC commands.

The critical Rust implementation detail: `git init` and `git clone` are invoked via `tokio::process::Command` (same pattern as existing spawner code) — no Rust git library is needed. The `git` binary is confirmed available on the host (`git version 2.39.5`). The existing `git/mod.rs` dispatcher is only for worktree/diff/status operations; the new git-init and git-clone commands belong in `ipc/project_handlers.rs` (local-only, consistent with the deferred SSH-aware scope).

**Primary recommendation:** Add two new `#[tauri::command]` functions in `project_handlers.rs` (`git_init_project` and `clone_project`), update `lib.rs` to register them, add two TanStack Query mutation hooks in `project.service.ts`, and extend `ProjectList.tsx` + `ProjectsListLayout.tsx` with the new footer and dialogs.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Non-git folder behavior**
- When a folder with no `.git` is selected via FilePicker: auto-init git silently — run `git init` automatically before `create_project`. No confirmation dialog.
- Git status is NOT shown in the FilePicker while browsing — check only at selection time.

**Button placement**
- Footer becomes a row of 3 buttons: [Select Existing] [Clone] [Create]
- "Select Existing" replaces the current "Select New Project" button (same behavior — opens FilePicker)
- Clone and Create each open their own modal dialog (same pattern as the existing FilePicker Dialog)

**Clone Project form**
- Inputs: git URL (text input) + target path (text input + Browse button that opens FilePicker to select parent directory)
- No branch field — clone default branch only
- Progress UX: spinner while cloning, dismiss dialog on success, show result via toast. No raw git output shown.
- Target path browsing: reuses the existing FilePicker component to pick a parent directory; user types or sees the resulting path in the text input

**Create Project form**
- Inputs: two separate fields — "Parent directory" (text input + Browse button) + "Folder name" (text input)
- No display name separate from folder name — the folder name IS the project name in Maestro
- Maestro concatenates parent dir + folder name to get the full path, creates the directory, runs `git init`, then calls `create_project`
- If the target directory already exists: fail with a clear inline error (not a toast) — "Directory already exists. Choose a different path or use Select Existing."

### Claude's Discretion
- Exact button sizing and visual weight within the 3-button footer (primary vs outline vs secondary variants)
- Whether Clone/Create dialogs share a single `<Dialog>` component with swappable content or are independent Dialog instances
- Error handling for invalid git URLs in Clone (inline validation vs server-side error)
- Whether the Browse button in Clone/Create dialogs opens a connection-aware FilePicker (same SSH support) or local-only

### Deferred Ideas (OUT OF SCOPE)
- Branch selection in Clone (clone non-default branch) — deferred, default branch only for now
- Template/starter support in Create — not in scope
- SSH-aware Clone/Create (cloning into remote servers) — scope unclear, defer; local only for v1
</user_constraints>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `tokio::process::Command` | (bundled in tokio 1.x, already in Cargo.toml) | Async subprocess for `git init` / `git clone` | Same crate already used in spawner.rs — no new dep |
| `std::fs::create_dir_all` | (std) | Create parent + folder for Create Project | Zero-cost, already used in project_storage.rs |
| `@tanstack/react-query` | already installed | useMutation hooks for clone/create IPC | Established pattern in project.service.ts |
| `sonner` | already installed | Toast feedback on clone/create success/error | Established pattern throughout the app |
| `@base-ui/react/dialog` | already installed (via `src/components/ui/dialog.tsx`) | Clone/Create modal dialogs | Same Dialog used by FilePicker |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `lucide-react` | already installed | Button icons (GitFork, FolderPlus, FolderOpen etc.) | Icon slots in 3-button footer |

**No new dependencies required.** All needed libraries are already in `Cargo.toml` and `package.json`.

## Architecture Patterns

### Recommended Project Structure

New files:
```
src/
├── components/project-picker/
│   ├── CloneProjectDialog.tsx   # New: Clone Project form modal
│   └── CreateProjectDialog.tsx  # New: Create Project form modal
├── services/
│   └── project.service.ts       # Extend: add useCloneProject + useCreateNewProject hooks
src-tauri/src/ipc/
└── project_handlers.rs          # Extend: add git_init_project + clone_project commands
```

Modified files:
```
src/components/project-picker/ProjectsListLayout.tsx  # Footer slot → 3-button row
src/components/project-picker/ProjectList.tsx          # Wire Clone/Create modals
src-tauri/src/lib.rs                                   # Register 2 new commands
```

### Pattern 1: Rust `git` subprocess via `tokio::process::Command`

**What:** Spawn `git` CLI as async subprocess, capture output, return `Result<(), String>`.
**When to use:** `git init` and `git clone` in new IPC handlers.

```rust
// Pattern already used in src-tauri/src/process/spawner.rs
use tokio::process::Command;
use std::process::Stdio;

pub async fn git_init_local(path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["init", path])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to spawn git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git init failed: {}", stderr))
    }
}
```

**Note:** `git init <path>` initializes a repo at the given path (creates the directory if needed — or use the path-exists form). For Create Project, `std::fs::create_dir` first, then `git init .` inside it, is cleaner for the "directory already exists" error check.

### Pattern 2: Extend `create_project` call sequence

**What:** New IPC commands do: filesystem work → git operation → call the existing `create_project` DB + `.maestro` logic.
**When to use:** Both `clone_project` and `create_project_with_init` should reuse the existing `create_project` handler rather than duplicating its DB + maestro-folder logic.

```rust
// In project_handlers.rs — new IPC commands delegate to existing create_project

#[tauri::command]
#[specta::specta]
pub async fn clone_project(
    app_state: State<'_, Arc<AppState>>,
    url: String,
    target_path: String,
) -> Result<Project, String> {
    // 1. git clone url target_path
    let output = Command::new("git")
        .args(["clone", &url, &target_path])
        .output().await
        .map_err(|e| format!("Failed to spawn git: {}", e))?;
    if !output.status.success() {
        return Err(format!("git clone failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    // 2. Register in DB + init .maestro
    create_project(app_state, target_path, None)
}
```

### Pattern 3: TanStack Query mutation hook in project.service.ts

**What:** Add `useCloneProject` and `useCreateNewProject` mutations following the existing `useCreateProject` pattern.
**When to use:** Called from `ProjectList.tsx` to drive dialog submit handlers.

```typescript
// Source: existing useCreateProject in src/services/project.service.ts
export function useCloneProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ url, targetPath }: { url: string; targetPath: string }) =>
      api.cloneProject(url, targetPath),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.listByConnection("local") });
      toast.success("Project cloned successfully");
    },
    onError: (error) => {
      toast.error(`Clone failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}
```

### Pattern 4: Footer slot refactor in ProjectsListLayout

**What:** Replace the single `onSelectNewClick` prop with a `footerContent: ReactNode` slot (or add `onCloneClick` and `onCreateClick` props alongside the existing one).
**Recommendation (Claude's discretion):** Use explicit callback props (`onSelectNewClick`, `onCloneClick`, `onCreateClick`) rather than a generic slot — keeps the component typed and testable.

```typescript
interface ProjectsListLayoutProps {
  headerContent: ReactNode;
  children: ReactNode;
  onBack: () => void;
  onSelectNewClick: () => void;
  onCloneClick: () => void;    // NEW
  onCreateClick: () => void;   // NEW
  loading?: boolean;
}
```

Footer JSX (3 equal-width buttons, outline for secondary actions):
```tsx
<div className="pt-4 border-t border-border flex gap-2">
  <Button onClick={onSelectNewClick} disabled={loading} variant="outline" size="sm" className="flex-1">
    <FolderOpen className="size-4" /> Select Existing
  </Button>
  <Button onClick={onCloneClick} disabled={loading} variant="outline" size="sm" className="flex-1">
    <GitFork className="size-4" /> Clone
  </Button>
  <Button onClick={onCreateClick} disabled={loading} variant="default" size="sm" className="flex-1">
    <FolderPlus className="size-4" /> Create
  </Button>
</div>
```

### Pattern 5: Dialog form for Clone / Create

**What:** Independent `<Dialog>` instances (one for Clone, one for Create) embedded in `ProjectList.tsx` alongside the existing FilePicker Dialog. Each dialog uses `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter`.
**Recommendation (Claude's discretion):** Separate Dialog instances (not swappable content in one Dialog) — simpler state management, cleaner unmount/remount behavior.

Clone dialog includes a nested FilePicker Dialog for directory picking (same Browse pattern). The selected path populates the target path text input.

```tsx
// CloneProjectDialog.tsx (simplified)
export function CloneProjectDialog({ open, onOpenChange, onSuccess }) {
  const [url, setUrl] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: cloneProject, isPending } = useCloneProject();

  const handleSubmit = async () => {
    setError(null);
    try {
      const project = await cloneProject({ url, targetPath });
      onSuccess(project);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));  // inline error for URL issues
    }
  };
  // ...
}
```

Create dialog checks for existing directory at submission time. The "already exists" error is inline (set local `error` state), not a toast.

### Anti-Patterns to Avoid

- **Don't call `create_project` Rust handler twice**: new IPC commands must call it internally, not have the frontend call `create_project` as a second IPC call after `clone_project`.
- **Don't use `std::process::Command` (sync)**: use `tokio::process::Command` for async IPC handlers that are `async fn`. Sync Command blocks the Tauri executor thread.
- **Don't show raw `git clone` output**: spec says spinner while cloning, dismiss on success. Raw stderr only goes to logs / error string.
- **Don't add `init_git` flag to existing `create_project`**: per CONTEXT.md, auto-init is triggered at selection time in the `handleProjectSelect` callback (frontend side), by calling a separate `git_init_project` IPC command before `create_project`. Keeps the existing handler unchanged.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Git subprocess invocation | Custom git library / bindings | `tokio::process::Command` + system `git` | Git CLI is always present; library adds binary size with no benefit here |
| Directory browser in dialogs | New directory tree component | Existing `FilePicker` component | Already handles local + SSH, keyboard nav, breadcrumbs |
| Modal dialog UI | Custom overlay/backdrop | `Dialog`/`DialogContent` from `src/components/ui/dialog.tsx` | Consistent with existing FilePicker modal |
| Path concatenation | Manual string joins | `std::path::Path::new(parent).join(folder_name)` | Cross-platform (avoids / vs \ issues on Windows) |
| Result unwrapping in frontend | Manual discriminated union | `api` proxy in `tauri-utils.ts` | Already unwraps `Result<T, E>` and throws on error |

**Key insight:** The path from URL + directory picker → DB project record is a 3-step sequence that already exists for all three cases (git op → DB insert → .maestro init). New commands just add the first step.

## Common Pitfalls

### Pitfall 1: Async IPC handler calling sync `create_project`

**What goes wrong:** `clone_project` is `async fn` (needs `await` for subprocess); the existing `create_project` is `fn` (sync). Calling a sync fn from async context is fine, but you must pass `app_state` by value clone or restructure.
**Why it happens:** Tauri State is `State<'_, Arc<AppState>>` — the Arc can be cloned, passing `app_state.clone()` or re-locking in the async handler.
**How to avoid:** In the async handler, perform the git subprocess, then lock the DB mutex directly (don't call `create_project` as a function — replicate the DB logic inline, or clone the Arc). The pattern in `get_connection_projects` (which is also `async fn`) shows the correct lock-release-before-async pattern.
**Warning signs:** `MutexGuard` held across an `.await` point → compile error `MutexGuard is not Send`.

### Pitfall 2: `git clone` output path vs. clone destination

**What goes wrong:** `git clone <url> <target>` clones into `<target>` directly. If `<target>` already exists and is non-empty, git fails. The form should show the resulting path clearly.
**Why it happens:** Users expect to pick a parent directory and have git create the repo folder inside it — but the IPC receives the full target path.
**How to avoid:** In the Clone dialog, the "target path" field is the full destination path (user types or browses to a parent, then the URL-derived repo name is appended client-side as a suggestion). Document in the plan whether the frontend auto-appends the repo name from the URL or requires the user to type the full path. **Recommendation:** Auto-derive repo name from URL for display, but let the user edit the full path field freely.

### Pitfall 3: `ProjectsListLayout` loading prop blocks all 3 buttons

**What goes wrong:** Current `disabled={loading}` disables the single button; after the refactor, all 3 buttons share `loading` — but `projectLoading` in `ProjectList` is only set during `handleProjectSelect`. Clone/Create have their own pending states from `useMutation`.
**Why it happens:** Single `loading` prop no longer covers the full loading semantics.
**How to avoid:** Each button should be individually disabled based on its own operation's `isPending`. Pass a combined `loading` only if any operation is in progress, or pass three separate disabled props.

### Pitfall 4: `create_project` already-exists dedup behavior

**What goes wrong:** The existing `create_project` handler does `SELECT id FROM projects WHERE path = ?` and returns the existing project if found. For Clone, if the user clones to a path already registered, the handler quietly returns the old project — which is correct behavior but may confuse the user if the clone already succeeded.
**Why it happens:** The DB dedup is silent.
**How to avoid:** Acceptable behavior — toast "Project cloned and opened" is enough. No action needed.

### Pitfall 5: Windows path separator in `git init <path>`

**What goes wrong:** `git init C:\Users\foo\bar` may fail or produce unexpected behavior depending on shell quoting.
**Why it happens:** `tokio::process::Command` passes args directly (no shell), so backslashes are fine. But the path string coming from the frontend (via FilePicker on Windows) uses forward slashes (DRIVES_ROOT pattern in FilePicker uses `C:/` format).
**How to avoid:** Pass path args directly to `Command::arg()` — no shell interpolation. Test on Windows with the `C:/` path format that FilePicker produces.

### Pitfall 6: `git clone` progress output on stderr

**What goes wrong:** `git clone` writes progress to stderr by default (`Cloning into '...'`, transfer stats). Capturing stderr and returning it on failure is correct, but the progress lines may look like errors.
**Why it happens:** Git uses stderr for informational output during clone.
**How to avoid:** On error, return `stderr` as the error string (it contains the actual error message). On success (exit code 0), ignore stderr content. The frontend shows a spinner; no streaming output needed.

## Code Examples

Verified patterns from existing codebase:

### Async IPC handler with subprocess (from spawner.rs)
```rust
// Source: src-tauri/src/process/spawner.rs
use tokio::process::Command;
use std::process::Stdio;

let output = Command::new("git")
    .args(["init", &path])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .output()
    .await
    .map_err(|e| format!("Failed to spawn git: {}", e))?;

if !output.status.success() {
    return Err(String::from_utf8_lossy(&output.stderr).to_string());
}
```

### Registering a new IPC command (from lib.rs)
```rust
// Source: src-tauri/src/lib.rs
.commands(collect_commands![
    // ...existing commands...
    crate::ipc::clone_project,
    crate::ipc::git_init_project,
])
```

### Dialog + FilePicker modal pattern (from ProjectList.tsx)
```tsx
// Source: src/components/project-picker/ProjectList.tsx
<Dialog open={showFilePickerModal} onOpenChange={setShowFilePickerModal}>
  <DialogContent className="h-150 md:max-w-4xl p-0 flex flex-col [&>button:hover]:text-accent">
    <FilePicker
      connection={activeConnection?.sshConnection}
      onProjectSelect={handleProjectSelect}
      loading={projectLoading}
    />
  </DialogContent>
</Dialog>
```

### TanStack Query mutation with cache invalidation (from project.service.ts)
```typescript
// Source: src/services/project.service.ts
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, connectionId }: { path: string; connectionId: number | null }) =>
      api.createProject(path, connectionId),
    onSuccess: (_data, { connectionId }) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listByConnection(connectionId ?? "local"),
      });
    },
    onError: (error) => {
      toast.error(`Failed to create project: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}
```

### Path join (cross-platform, from project_handlers.rs pattern)
```rust
use std::path::Path;
let full_path = Path::new(&parent_dir).join(&folder_name);
let full_path_str = full_path.to_str()
    .ok_or_else(|| "Invalid path characters".to_string())?
    .to_string();
```

### Auto-detect git and init if missing (frontend handleProjectSelect extension)
```typescript
// Extension of handleProjectSelect in ProjectList.tsx
const handleProjectSelect = async (selectedPath: string, connectionId?: number) => {
  setProjectLoading(true);
  try {
    // NEW: auto-init git if no .git directory exists
    await gitInitIfNeeded({ path: selectedPath });  // mutation, silent
    const result = await createProject({ path: selectedPath, connectionId: connectionId ?? null });
    setSelectedProject(result);
    setShowFilePickerModal(false);
  } finally {
    setProjectLoading(false);
  }
};
```

Or alternatively — let the Rust `create_project` handler call `git_init_if_needed` internally:
```rust
// In create_project Rust handler, before DB insert:
let git_dir = Path::new(&path).join(".git");
if !git_dir.exists() {
    // silently init
    let _ = Command::new("git").args(["init", &path]).output().await;
}
```

**Recommendation:** Do it in Rust inside `create_project` — simpler, no additional IPC round-trip, and the CONTEXT says "before `create_project`" but that can mean logically before the DB record, not necessarily a separate IPC call. However, `create_project` is currently `fn` (sync), not `async fn`. Adding `await` requires making it `async fn`. **Decision for planner:** Either (a) extract `git_init_if_needed` as a separate async IPC command called from the frontend before `createProject`, or (b) make `create_project` async. Option (a) is lower-risk.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Direct `invoke()` calls | `api` proxy + TanStack Query hooks | Phase 20 | All new service calls must use `useMutation` / `useQuery` |
| Single footer button in ProjectsListLayout | 3-button footer row | This phase | `onSelectNewClick` prop stays; add `onCloneClick`, `onCreateClick` |
| Existing `commands` object from bindings | Service hooks (`useCreateProject` etc.) | Phase 21 | New IPC commands must get corresponding service hook, not raw `commands` usage |

## Open Questions

1. **Should `create_project` be made `async` to embed `git init` check?**
   - What we know: It's currently `fn` (sync). Making it `async` requires updating `lib.rs` registration and all callers.
   - What's unclear: Whether the planner wants to make this change or use a separate `git_init_project` IPC call from the frontend.
   - Recommendation: Keep `create_project` sync. Add `git_init_project(path: String) -> Result<(), String>` as a separate async IPC command. Call it from `handleProjectSelect` in the frontend before `createProject`. One extra IPC round-trip is negligible.

2. **Clone dialog: who appends the repo name to the target path?**
   - What we know: `git clone <url> <target>` uses `<target>` as the full destination. The form has a "target path" input + Browse button.
   - What's unclear: Whether the repo name is auto-derived from the URL and appended, or the user types the full path.
   - Recommendation: Auto-derive repo name from URL (last path segment before `.git`) and pre-populate the full target path as `<parent>/<repo-name>`. User can edit before submitting.

3. **FilePicker in Clone/Create dialogs: connection-aware or local-only?**
   - What we know: CONTEXT marks this as Claude's discretion. Clone/Create are deferred for SSH scope.
   - Recommendation: Pass `connection={null}` (local-only) to FilePicker inside Clone/Create dialogs for now. The `FilePicker` component already handles `null` connection gracefully (local mode).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `git` CLI | `git init`, `git clone` | Yes | 2.39.5 | None — git is a hard requirement for Maestro |
| `tokio` | Async subprocess | Yes (Cargo.toml) | 1.x | — |
| `std::fs` | `create_dir` for Create Project | Yes (std) | — | — |

No missing dependencies.

## Validation Architecture

> `workflow.nyquist_validation` key is absent from config.json — treated as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | vite.config.ts (vitest config inline) |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| P24-01 | `ProjectsListLayout` renders 3-button footer with correct callbacks | unit | `pnpm test -- ProjectsListLayout` | Needs new test |
| P24-02 | `CloneProjectDialog` shows spinner while `isPending`, closes on success | unit | `pnpm test -- CloneProjectDialog` | New file — Wave 0 gap |
| P24-03 | `CreateProjectDialog` shows inline error when directory exists | unit | `pnpm test -- CreateProjectDialog` | New file — Wave 0 gap |
| P24-04 | `handleProjectSelect` calls `git_init_project` when no `.git` found | unit (mock IPC) | `pnpm test -- ProjectList` | Needs new test |

### Sampling Rate
- **Per task commit:** `pnpm test`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/components/project-picker/CloneProjectDialog.test.tsx` — covers P24-02
- [ ] `src/components/project-picker/CreateProjectDialog.test.tsx` — covers P24-03

*(Existing `ProjectPicker.test.tsx` can be extended for P24-01 and P24-04 in the same plan or in dedicated test additions.)*

## Project Constraints (from CLAUDE.md)

- Use direct imports — no barrel `index.ts` roundtrips for new component files
- Use `@/ui/dialog`, `@/ui/button`, `@/ui/input` (shadcn/ui) for all dialog form elements
- Use `@/lib` (`api`) proxy + TanStack Query `useMutation` for all new IPC calls — never raw `invoke()`
- Rust models: add `#[derive(Serialize, Deserialize, TS)]` + `#[ts(export)]` to any new structs; run `pnpm tauri:gen` after Rust model changes
- No new Rust types needed for this phase (inputs are primitives; return type is existing `Project`)
- State management: Zustand stores not needed here — dialog open/close state is local `useState`
- TypeScript strict mode; no `any` types

## Sources

### Primary (HIGH confidence)
- Direct code reading: `src-tauri/src/ipc/project_handlers.rs` — `create_project` implementation
- Direct code reading: `src-tauri/src/process/spawner.rs` — `tokio::process::Command` pattern
- Direct code reading: `src/components/project-picker/ProjectList.tsx` — Dialog + FilePicker modal pattern
- Direct code reading: `src/components/project-picker/ProjectsListLayout.tsx` — current footer structure
- Direct code reading: `src/services/project.service.ts` — TanStack Query mutation pattern
- Direct code reading: `src-tauri/src/lib.rs` — command registration pattern
- Direct code reading: `src-tauri/Cargo.toml` — confirmed no new dependencies needed
- Direct code reading: `src/utils/helpers/tauri-utils.ts` — `api` proxy pattern

### Secondary (MEDIUM confidence)
- `git init <path>` behavior: documented git behavior, confirmed via git 2.39.5 on host
- `git clone <url> <target>`: standard git behavior, stderr contains progress + errors

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in use, verified by code reading
- Architecture: HIGH — patterns directly lifted from existing analogous code
- Pitfalls: HIGH — derived from reading actual Rust handler structure (sync fn vs async fn issue is a real constraint)
- Test gaps: MEDIUM — test structure inferred from existing `ProjectPicker.test.tsx` pattern

**Research date:** 2026-03-28
**Valid until:** 2026-04-28 (stable stack, no fast-moving dependencies)
