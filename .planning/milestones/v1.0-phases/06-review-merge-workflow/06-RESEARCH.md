# Phase 6: Review & Merge Workflow - Research

**Researched:** 2026-02-06
**Domain:** Diff presentation, approval workflows, and git merge automation
**Confidence:** HIGH

## Summary

Phase 6 implements human-in-the-loop approval gates for agent-generated code changes. The phase requires three integrated systems: (1) unified diff rendering with syntax highlighting and file tree navigation, (2) structured approval workflows capturing feedback, and (3) safe git merge automation with conflict detection.

Key findings:
- **Diff rendering:** Use `git-diff-view` library for production-grade diff component with built-in Shiki syntax highlighting, supporting both split and unified views with full customization
- **Git operations:** Leverage existing `simple-git` in Node.js sidecar for merge, conflict detection, and cleanup operations (no new Rust dependencies needed)
- **Approval model:** Extend existing database schema with feedback table to capture per-task approval decisions, per-file comments, and general feedback
- **Notifications:** Use existing `sonner` toast library for merge completion/error notifications

**Primary recommendation:** Use `@git-diff-view/react` with Shiki for diff rendering, extend database schema with approval feedback table, implement merge automation in Node.js sidecar leveraging simple-git's MergeResult conflict detection.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Diff Presentation
- Unified view (like GitHub) — single column showing removed (-) and added (+) lines in sequence
- Full syntax highlighting by language (JS/TS/Rust/etc.) for easier code reading
- File tree navigation on left side — collapsible folder structure showing all changed files
- 5-7 context lines around each change (balanced context without overwhelming the view)

#### Approval Mechanics
- Three approval actions: Approve, Request Changes, Comment
- Feedback captured via both general text field AND per-file comments (structured + freeform)
- Request Changes moves task back to InProgress column (user can re-execute agent or fix manually)
- Comment-only NOT supported — all comments require Approve or Request Changes decision

#### Merge Behavior
- Squash merge strategy (all agent commits squashed into single commit on main)
- Merge conflicts trigger auto-reject to InProgress with conflict feedback
- On successful merge: task moves to Done, worktree and branch immediately cleaned up and returned to pool
- No pre-merge testing — user reviews diffs and execution logs, trusts agent output

#### Safety and Visibility
- Task status indicators (e.g., "Merging..." badge) + toast notifications on completion
- No undo/revert UI — user handles rollbacks via terminal/git commands if needed
- Merge errors (non-conflict) show error modal with details, task stays in Review
- No action blocking during merge — rely on worktree isolation to prevent conflicts

### Claude's Discretion
- Exact diff parsing and rendering implementation
- File tree collapsing/expanding behavior
- Toast notification timing and styling
- Error modal layout and styling
- Comment attachment UI (per-file vs inline)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.

</user_constraints>

## Standard Stack

### Frontend (React + TypeScript)

#### Diff Rendering (Core)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@git-diff-view/react` | Latest | Production diff component with unified/split modes | 134 code snippets, benchmark 87.4, supports full syntax highlighting, context lines, customization |
| `@git-diff-view/shiki` | Latest | Syntax highlighter integration for language support | Handles JS/TS/Rust/Python/Go with language detection |
| `@git-diff-view/core` | Latest | Diff parsing and line-level operations | Supports unified diff format, context extraction, split/unified rendering |

#### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `sonner` | v1.5.0+ | Toast notifications (already in project) | Merge completion, error messages |
| `@radix-ui/react-dialog` | v1.1.0+ | Error modal dialogs (already in project) | Non-conflict merge errors |

#### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@git-diff-view/react` | `react-diff-view` | react-diff-view has 37 snippets vs 134, less active, missing WebWorker support for performance |
| `@git-diff-view/react` | `react-diff-viewer-continued` | Only 13 snippets, less mature, requires separate syntax highlighting |
| Shiki | Prism.js | Prism is lightweight but Shiki has richer context awareness for code |

**Installation:**
```bash
npm install @git-diff-view/react @git-diff-view/shiki @git-diff-view/core
```

### Backend (Rust + Node.js Sidecar)

#### Git Merge Operations (Node.js Sidecar)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `simple-git` | v3.20+ (already in project) | Squash merge, conflict detection, branch operations | 311 snippets, HIGH reputation, already used for worktree ops |

#### Supporting (Rust)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `rusqlite` | v0.31 (already in project) | Store feedback and approval state | Existing infrastructure |
| `tokio` | v1.x full (already in project) | Async Tauri commands for merge operations | Existing runtime |

**No new dependencies needed** — simple-git already supports merge operations with conflict detection.

## Architecture Patterns

### Recommended Project Structure

Frontend additions:
```
src/
├── components/
│   ├── ReviewModal.tsx          # Main approval workflow UI
│   ├── DiffViewer.tsx           # Diff rendering component
│   ├── FileTree.tsx             # Collapsible file navigation
│   └── ApprovalForm.tsx         # Feedback capture UI
├── store/
│   └── reviewStore.ts           # Approval state management (Zustand)
└── types/
    └── review.ts                # Approval, feedback type definitions
```

Backend additions:
```
src-tauri/src/
├── models/
│   └── review.rs                # ReviewFeedback, ApprovalDecision enums
└── ipc/handlers.rs
    ├── approve_task()           # Start merge process
    └── reject_task()            # Capture rejection feedback

sidecar/src/
├── merge-manager.ts             # Merge automation, conflict handling
└── index.ts (update)            # Export merge functions
```

Database additions:
```sql
CREATE TABLE task_reviews (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL UNIQUE,
  decision TEXT NOT NULL,        -- Approve, RequestChanges
  general_feedback TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE review_comments (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,       -- For per-file comments
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(review_id) REFERENCES task_reviews(id) ON DELETE CASCADE
);
```

### Pattern 1: Diff Generation from Worktree

**What:** Get unified diff between agent branch and main branch, formatted for UI consumption.

**When to use:** User clicks "Review" to view changes before approval.

**Example (Node.js sidecar):**
```typescript
// Source: simple-git documentation
import { simpleGit } from "simple-git";

export async function getDiffBetweenBranches(
  repoPath: string,
  fromBranch: string,
  toBranch: string
): Promise<string> {
  const git = simpleGit(repoPath);

  // Get unified diff with context lines (default 3, spec requires 5-7)
  const diff = await git.diff([
    `${toBranch}..${fromBranch}`,  // main..agent-task-123
    "--unified=6",                  // 6 context lines
    "--function-context",           // Show function names in hunk headers
  ]);

  return diff;  // Raw unified diff string
}
```

### Pattern 2: Diff Rendering with File Tree Navigation

**What:** Parse diff, extract file list, render unified view with left sidebar file tree.

**When to use:** Display changes in ReviewModal with collapsible navigation.

**Architecture:**
```typescript
// Source: @git-diff-view/react documentation
import { DiffView, DiffModeEnum, DiffFile } from "@git-diff-view/react";
import { getDiffViewHighlighter } from "@git-diff-view/shiki";
import "@git-diff-view/react/styles/diff-view.css";

function ReviewModal({ taskId }: { taskId: number }) {
  const [highlighter, setHighlighter] = useState(null);
  const [diffData, setDiffData] = useState(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    // Load syntax highlighter asynchronously
    getDiffViewHighlighter().then(setHighlighter);
  }, []);

  useEffect(() => {
    // Fetch diff for agent branch vs main
    fetchDiff(taskId).then(diff => {
      // Parse unified diff into structured format
      const files = parseDiffFormat(diff);
      setDiffData(files);
      if (files.length > 0) {
        setSelectedFile(files[0].fileName);
      }
    });
  }, [taskId]);

  if (!highlighter || !diffData) return <Loading />;

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      {/* Left: File Tree Navigation */}
      <FileTree
        files={diffData}
        selectedFile={selectedFile}
        onSelectFile={setSelectedFile}
      />

      {/* Right: Diff Viewer */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {selectedFile && (
          <DiffView
            data={diffData.find(f => f.fileName === selectedFile)}
            diffViewMode={DiffModeEnum.Unified}  // Single column like GitHub
            diffViewTheme="light"
            diffViewHighlight
            registerHighlighter={highlighter}
          />
        )}
      </div>
    </div>
  );
}
```

### Pattern 3: Approval Decision Capture

**What:** Store user's approval/rejection decision with feedback.

**When to use:** User clicks "Approve" or "Request Changes" button.

**Structure:**
```typescript
interface ReviewFeedback {
  taskId: number;
  decision: "Approve" | "RequestChanges";
  generalFeedback?: string;
  perFileComments?: Array<{
    filePath: string;
    comment: string;
  }>;
}

// Rust model for database persistence
#[derive(Serialize, Deserialize, TS)]
pub struct ReviewFeedback {
    pub task_id: i32,
    pub decision: ReviewDecision,
    pub general_feedback: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, TS)]
#[serde(rename_all = "PascalCase")]
pub enum ReviewDecision {
    Approve,
    RequestChanges,
}
```

### Pattern 4: Squash Merge with Conflict Detection

**What:** Attempt squash merge of agent branch to main, capture conflict state.

**When to use:** User approves task, system initiates automated merge.

**Implementation (Node.js sidecar):**
```typescript
// Source: simple-git merge documentation
import { simpleGit, MergeResult } from "simple-git";

export async function squashMergeToMain(
  repoPath: string,
  branchName: string
): Promise<{ success: boolean; conflicts: string[] }> {
  const git = simpleGit(repoPath);

  try {
    // Attempt squash merge to main
    const result: MergeResult = await git.merge([
      branchName,
      "--squash",           // Squash all commits into one
      "--no-commit",        // Don't auto-commit, let us control message
    ]);

    if (result.failed) {
      // Merge conflict detected
      return {
        success: false,
        conflicts: result.conflicts || [],
      };
    }

    // Create merge commit with task reference
    const commitMsg = `Merge task from ${branchName}

Task completed by AI agent. All changes squashed into single commit.`;

    await git.commit(commitMsg);
    return { success: true, conflicts: [] };
  } catch (error) {
    // Non-conflict merge error (e.g., permission, stale branch)
    return {
      success: false,
      conflicts: [`Merge error: ${error.message}`],
    };
  }
}
```

### Pattern 5: Task Status and Error Notifications

**What:** Update task status during merge, show notifications on completion/error.

**When to use:** Async merge operation, track in real-time.

**Implementation:**
```typescript
// Frontend: Zustand store action
const reviewStore = create<ReviewStore>((set, get) => ({
  mergeInProgress: false,

  async approveAndMerge(taskId: number) {
    set({ mergeInProgress: true });

    try {
      // Call Tauri command to merge and update DB
      const result = await invoke<MergeResult>("approve_task_and_merge", {
        taskId,
      });

      if (result.conflicts.length > 0) {
        // Merge conflict: reject task, show error
        toast.error(`Merge conflict detected:\n${result.conflicts.join("\n")}`);
        set({ mergeInProgress: false });
      } else {
        // Success: task auto-moves to Done, worktree cleaned up
        toast.success("Merge successful! Task moved to Done.");
        set({ mergeInProgress: false });
      }
    } catch (err) {
      toast.error(`Merge failed: ${err.message}`);
      set({ mergeInProgress: false });
    }
  },
}));
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Diff rendering with syntax highlighting | Custom diff parser + HTML generation | `@git-diff-view/react` + Shiki | Complex language detection, context extraction, performance optimization for large diffs, already handles split/unified modes |
| File tree navigation | Manual file list + collapse state tracking | `@git-diff-view/react` file sidebar component | Needs keyboard navigation, virtual scrolling for large filesets, active file persistence |
| Merge conflict detection | Manual git output parsing | `simple-git` MergeResult object | Captures conflict markers, handles edge cases (renamed files, mode changes), properly detects --squash failures |
| Toast notifications | Custom div + CSS animations | `sonner` (already in project) | Timing, stacking, accessibility, theme consistency |

**Key insight:** Diff rendering is not a "simple task" — production implementations must handle binary files, large diffs (100+ files), CRLF normalization, renamed files, and performance. `@git-diff-view/react` handles all this.

## Common Pitfalls

### Pitfall 1: Assuming Merge Conflicts Are Simple

**What goes wrong:** Treat merge conflicts as just "lines with <<<, >>>" markers. Code may not render correctly in diff viewer, manual editing becomes necessary.

**Why it happens:** Git conflict markers are raw and context-sensitive. Users need clear visualization of what changed in both branches to make decisions.

**How to avoid:**
- Always fetch full diff BEFORE merge attempt (show user exact changes first)
- After conflict detection, show conflict markers in diff viewer with visual indicators
- Guidance: "Resolve conflicts manually in terminal or re-run agent"

**Warning signs:**
- Users saying they "didn't see the conflict coming" — diff not shown before approval
- Task stuck in Review with no feedback path — error modal not showing conflict details

### Pitfall 2: Not Showing Adequate Context

**What goes wrong:** User requests changes but diff viewer only shows changed lines with 0-2 context lines. Hard to understand implications of changes.

**Why it happens:** Diff tools can show minimal context to save screen space, but developers need surrounding code to reason about changes.

**How to avoid:**
- Always render 5-7 context lines (user decision in CONTEXT.md) around each hunk
- Make context configurable but default to 6 lines
- Use `--function-context` in git diff to show function names in hunk headers

**Warning signs:**
- Users request changes saying "didn't understand what changed"
- High rejection rate due to "insufficient context"

### Pitfall 3: Task Status Not Updated During Merge

**What goes wrong:** User clicks "Approve" and see no feedback. Task stuck in Review. User can't tell if merge is happening or failed.

**Why it happens:** Merge is async operation, but UI isn't updated in real-time. Need task status badge (e.g., "Merging...") and completion notification.

**How to avoid:**
- Update task status to a transient "Merging" state immediately
- Show toast notification when merge starts ("Merging to main...")
- Show toast notification on completion or error
- Remove "Merging" state when done (either Done or back to InProgress on error)

**Warning signs:**
- Users clicking "Approve" multiple times (didn't see feedback)
- "Did that work?" messages in logs — user confusion about async progress

### Pitfall 4: Squash Merge Breaking Commit History

**What goes wrong:** All agent commits squashed into one, but commit message doesn't capture original task intent. Main branch history becomes hard to understand.

**Why it happens:** Default squash merge commit message lists all original commits. For multi-file changes, this is verbose and unhelpful.

**How to avoid:**
- Customize squash merge commit message to reference task ID and brief description
- Example: `"Merge task #42: Add user authentication\n\nAll agent commits squashed into single commit."`
- Include task description from database, not just branch name

**Warning signs:**
- Main branch commit history full of internal agent commit messages
- Hard to correlate main commits back to tasks

### Pitfall 5: Leaving Stale Worktrees After Failed Merge

**What goes wrong:** Merge fails (conflict), task returns to InProgress. Worktree still exists, wasting disk space. If multiple agents retry, pool may be exhausted.

**Why it happens:** Cleanup logic only runs on successful merge. Failed merge leaves worktree in "dirty" state.

**How to avoid:**
- Only delete worktree on SUCCESSFUL merge (committed in main)
- On conflict/error, leave worktree as-is so user can manually inspect or re-run agent
- Track dirty worktrees separately (in db, status = "Dirty") for later cleanup UI

**Warning signs:**
- `.worktree-pool/` directory growing over time
- "Pool exhausted" errors on task execution
- Orphaned .git/worktrees metadata accumulating

## Code Examples

### Fetch Diff for Review

Source: simple-git documentation + @git-diff-view/react

```typescript
// sidecar/src/merge-manager.ts
import { simpleGit } from "simple-git";

export async function fetchDiffForReview(
  repoPath: string,
  taskId: number,
  taskBranchName: string
): Promise<string> {
  const git = simpleGit(repoPath);

  try {
    // Get unified diff with 6 context lines
    const diff = await git.diff([
      `main..${taskBranchName}`,
      "--unified=6",
      "--function-context",
      "--no-ext-diff",
    ]);

    return diff;
  } catch (error) {
    throw new Error(`Failed to fetch diff for task ${taskId}: ${error.message}`);
  }
}
```

### Parse Diff and Extract Files

Source: @git-diff-view/core

```typescript
// Frontend: ReviewModal.tsx
import { DiffFile } from "@git-diff-view/core";

function parseDiffFormat(
  unifiedDiffString: string
): Array<{ fileName: string; oldContent: string; newContent: string; hunks: string[] }> {
  // Use @git-diff-view/core to parse unified diff
  // Extract file names and hunks automatically
  const files: any[] = [];
  const lines = unifiedDiffString.split("\n");

  let currentFile: string | null = null;
  let hunks: string[] = [];
  let currentHunk = "";

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (currentFile) {
        files.push({
          fileName: currentFile,
          hunks,
        });
      }
      // Parse: diff --git a/path b/path
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      if (match) {
        currentFile = match[2];
        hunks = [];
      }
    }

    if (line.startsWith("@@")) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = line;
    } else if (line.startsWith("-") || line.startsWith("+") || line.startsWith(" ")) {
      currentHunk += "\n" + line;
    }
  }

  return files;
}
```

### Approve Task and Merge

Source: simple-git + Tauri IPC

```rust
// src-tauri/src/ipc/handlers.rs
#[tauri::command]
pub async fn approve_task_and_merge(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<serde_json::json, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Get task details
    let task: (i32, String) = conn
        .query_row(
            "SELECT id, name FROM tasks WHERE id = ?",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    // Call sidecar to perform squash merge
    // This would invoke Node.js sidecar via process spawning
    // (Implementation details depend on existing sidecar integration)

    Ok(json!({ "success": true, "message": "Task approved and merged" }))
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual diff viewing via `git diff` terminal command | Integrated diff viewer component with syntax highlighting | 2020+ (all modern code review tools) | Better UX, context-aware highlighting, familiar GitHub-style interface |
| Separate conflict resolution UI | Unified merge preview + conflict visualization | 2018+ (GitHub, GitLab) | Users see diffs before merge, conflicts are visible in context |
| Merge immediately after approval | Transient "Merging..." status + toast notifications | 2020+ (async operations become norm) | Users know operation is in-flight, can see completion/error |
| Manual worktree cleanup | Automatic cleanup after successful merge | 2019+ (orchestration tools) | Prevents disk exhaustion, cleaner repository state |

**Deprecated/outdated:**
- **Manual diff inspection via terminal:** Replaced by visual diff viewers (hard to understand changes in terminal format)
- **No context in diffs:** Replaced by configurable context lines (developers need surrounding code to reason about changes)
- **Merge conflicts = user must resolve manually:** Partially replaced by showing conflicts in UI context (still requires manual resolution, but with better visualization)

## Open Questions

1. **Per-file comment attachment UI:**
   - What we know: Diff viewer supports custom widgets on each line
   - What's unclear: Inline comment box vs sidebar comment list? Where do comments show up in the approval form?
   - Recommendation: Start with per-file comments in form (structured text input), not inline. Inline comments add UI complexity without MVP value.

2. **Diff size limits:**
   - What we know: Large diffs (100+ files) may cause performance issues
   - What's unclear: Should we paginate? Show file list only, lazy-load diffs? Disable syntax highlighting for huge files?
   - Recommendation: Start without limits, add virtual scrolling/pagination if performance issues surface

3. **Binary file handling:**
   - What we know: Diff viewers skip binary files by default
   - What's unclear: Should binary file changes be shown as "binary diff" or just listed as changed?
   - Recommendation: Show in file tree but with [binary] indicator, no diff content

## Sources

### Primary (HIGH confidence)
- `/mrwangjusttodo/git-diff-view` - Comprehensive diff component with Shiki integration, 134 code snippets
  - Topics: DiffView component, Shiki highlighter setup, unified/split modes, customization
  - Verified: Context7 official documentation with production examples
- `/steveukx/git-js` - Simple-git merge and diff operations
  - Topics: Merge with options, squash merge, conflict detection, diff extraction
  - Verified: Context7 official documentation, simple-git is established tool
- Existing project: `package.json` and `Cargo.toml` confirm sonner, @radix-ui, simple-git already installed

### Secondary (MEDIUM confidence)
- `/otakustay/react-diff-view` - Alternative diff component, verified with Context7
  - Used for comparison, confirmed less mature than git-diff-view

### Tertiary (LOW confidence)
- None — all findings verified through Context7 or existing project dependencies

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - @git-diff-view/react is production-grade (87.4 benchmark, 134 snippets, HIGH reputation), simple-git is established for 5+ years
- Architecture: HIGH - Patterns verified with Context7 documentation and existing codebase (Phase 5 patterns apply here)
- Pitfalls: HIGH - Based on user decisions from CONTEXT.md and common code review tool patterns
- Open questions: MEDIUM - Some edge cases (binary files, huge diffs) not fully explored

**Research date:** 2026-02-06
**Valid until:** 2026-03-06 (30 days for stable libraries, but check git-diff-view release notes for updates)

**Next steps for planner:**
1. Create ReviewModal component using @git-diff-view/react
2. Extend database schema with task_reviews and review_comments tables
3. Implement approve_task_and_merge Tauri command
4. Add squashMergeToMain and getDiffForReview functions to sidecar
5. Add task status transient states (Merging) to database and UI
6. Integrate toast notifications for merge completion/errors
