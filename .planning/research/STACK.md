# Stack Research

**Domain:** Tauri 2 desktop app — v1.3 Agents & Worktrees views + on-demand worktree backend
**Researched:** 2026-03-29
**Confidence:** HIGH (all versions verified against npm registry and docs.rs)

## What Already Exists (Do Not Re-Add)

| Package | Installed Version | Latest Stable | Status |
|---------|-------------------|---------------|--------|
| `@xterm/xterm` | `^6.0.0` | 6.0.0 | At latest |
| `@xterm/addon-fit` | `^0.11.0` | 0.11.0 | At latest |
| `@xterm/addon-attach` | `^0.12.0` | 0.12.0 | At latest |
| `@git-diff-view/react` | `^0.1.3` | 0.1.3 | Reuse from review flow |
| `portable-pty` (Rust) | `0.9.0` | — | PTY sessions, no change needed |

---

## New Frontend Packages Needed

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@xterm/addon-search` | `^0.16.0` | In-terminal text search for agent output | Official xtermjs addon, latest stable. Agent logs are long — search is essential. Same namespace/API surface as existing addons, zero integration friction |
| `@xterm/addon-web-links` | `^0.12.0` | Clickable URLs in terminal output | Official addon, latest stable. Agent output frequently contains file paths and https:// links. Makes terminal output actionable |

### Supporting Libraries

None needed. All other frontend requirements (diff rendering, state, IPC) are already covered by existing packages.

---

## New Rust Crates Needed

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `git2` | `0.20.4` | Git worktree listing, per-worktree diffs, status | Bindings to libgit2 (battle-tested C library). Provides `Repository::worktrees()`, `diff_tree_to_workdir_with_index()`, `statuses()` — exactly what the Worktrees view needs. Released 2026-02-02 |
| `notify` | `8.2.0` | Real-time worktree file watching | Cross-platform (macOS FSEvents, Linux inotify, Windows ReadDirectoryChangesW). Use `recommended_watcher()` → emit Tauri events on change. Released 2025-08-03 |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `notify` async feature | via `notify` | Tokio-compatible event stream | Enable if you want `async` watcher; otherwise use `spawn_blocking` around the sync channel loop |

---

## Installation

```bash
# Frontend — two missing xterm addons
pnpm add @xterm/addon-search@^0.16.0 @xterm/addon-web-links@^0.12.0
```

```toml
# src-tauri/Cargo.toml — add to [dependencies]

# Git operations — vendored libgit2 avoids system dependency (matches rusqlite bundled pattern)
git2 = { version = "0.20.4", features = ["vendored-libgit2"] }

# File watching — cross-platform, used directly (no Tauri plugin wrapper for v2)
notify = "8.2.0"
```

---

## API Reference

### git2: Worktree Listing

```rust
let repo = Repository::open(project_path)?;
let worktrees = repo.worktrees()?;           // StringArray of worktree names
for name in worktrees.iter().flatten() {
    let wt = repo.find_worktree(name)?;
    let wt_path = wt.path();                 // &Path — open as separate repo for diff
    let is_locked = wt.is_locked();
}
```

### git2: Per-Worktree Diff vs HEAD

```rust
let wt_repo = Repository::open(worktree_path)?;
let head_commit = wt_repo.head()?.peel_to_commit()?;
let head_tree = head_commit.tree()?;
// Includes both staged and unstaged changes
let diff = wt_repo.diff_tree_to_workdir_with_index(Some(&head_tree), None)?;
let stats = diff.stats()?;
// stats.files_changed(), stats.insertions(), stats.deletions()
```

### git2: Worktree Status (Zombie Detection)

```rust
let statuses = wt_repo.statuses(None)?;
// Iterate StatusEntry items; check status flags (INDEX_NEW, WT_MODIFIED, CONFLICTED, etc.)
// A worktree with no associated task record and no changes = zombie candidate
```

### notify: Worktree File Watching (Tauri 2 Pattern)

```rust
use notify::{recommended_watcher, RecursiveMode, Watcher};
use std::sync::mpsc;

let (tx, rx) = mpsc::channel();
let mut watcher = recommended_watcher(tx)?;
watcher.watch(worktree_path, RecursiveMode::Recursive)?;

// Run in tokio::task::spawn_blocking to avoid blocking async runtime
tokio::task::spawn_blocking(move || {
    for event in rx {
        // emit Tauri event to frontend
        app_handle.emit("worktree-changed", payload)?;
    }
});
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `git2` | `gix` (gitoxide) | When eliminating C dependencies is the top priority; gix API is still stabilizing as of 2026 |
| `git2` | Shell `git` commands (already in codebase) | For simple one-off operations; git2 is better for structured diff/status data |
| `notify` | `tauri-plugin-fs-watch` | Never — that plugin is Tauri v1 only and not maintained for v2 |
| `notify` polling fallback (`PollWatcher`) | `notify` with native backend | Only if native backend is unreliable for a specific deployment environment |
| `@xterm/addon-search` | Custom search overlay | Never — the official addon is maintained by the xtermjs team and matches the existing addon pattern exactly |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `tauri-plugin-fs-watch` | Tauri v1 only — repo is read-only mirror, no v2 version exists | `notify` crate directly in Rust |
| `@xterm/addon-canvas` | Canvas renderer addon; xterm v6 defaults to WebGL — switching renderers is not needed | N/A |
| `diff2html` or `react-diff-viewer` | Already have `@git-diff-view/react` from review flow — reuse it | `@git-diff-view/react` |
| `libgit2-sys` directly | Low-level C FFI bindings; `git2` is the safe Rust wrapper | `git2` |
| `watchexec-lib` | Designed for CLI tool use (re-running commands), not embedded app use | `notify` |
| `gix` (gitoxide) | Pure-Rust alternative to git2, but API is still stabilizing and lacks worktree support maturity | `git2` |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@xterm/addon-search@0.16.0` | `@xterm/xterm@6.0.0` | Same `@xterm/*` npm namespace — guaranteed compatibility |
| `@xterm/addon-web-links@0.12.0` | `@xterm/xterm@6.0.0` | Same namespace — guaranteed compatibility |
| `git2@0.20.4` | libgit2 >= 1.8 (bundled via `vendored-libgit2` feature) | Mirrors how `rusqlite = { features = ["bundled"] }` works — no system dep |
| `notify@8.2.0` | `tokio@1.x` | Use `spawn_blocking` for sync channel OR enable `notify`'s `async` feature for native async |

---

## Stack Patterns by Variant

**If worktree watching is per-view (only active while Worktrees view is open):**
- Start the `notify` watcher when the Worktrees view mounts, stop it on unmount
- Frontend calls a `start_worktree_watch` IPC command, backend drops the watcher when the frontend calls `stop_worktree_watch`

**If worktree watching is always-on (background daemon):**
- Hold the watcher in `AppState` (behind a Mutex)
- Start on project open, stop on project close
- Higher complexity — only worth it if other views need live worktree status

**If diff display is a quick summary (files changed / lines +/-):**
- Use `git2` stats only: `diff.stats()?.files_changed()`, `insertions()`, `deletions()`
- No need to stream patch data

**If diff display is full patch view (Worktrees view shows file-by-file diff):**
- Use `diff.print(DiffFormat::Patch, callback)` to collect unified diff string
- Pass to `@git-diff-view/react` (already installed) for rendering — consistent with review flow

---

## Sources

- npm registry `/@xterm/addon-search` — `dist-tags.latest: 0.16.0` (verified 2026-03-29)
- npm registry `/@xterm/addon-web-links` — `dist-tags.latest: 0.12.0` (verified 2026-03-29)
- npm registry `/@xterm/xterm` — `dist-tags.latest: 6.0.0` (verified 2026-03-29)
- npm registry `/@xterm/addon-fit` — `dist-tags.latest: 0.11.0` — already installed at latest (verified 2026-03-29)
- npm registry `/@xterm/addon-attach` — `dist-tags.latest: 0.12.0` — already installed at latest (verified 2026-03-29)
- https://docs.rs/git2/latest/git2/ — version 0.20.4, released 2026-02-02; Repository struct diff/worktree/status APIs confirmed (HIGH confidence)
- https://docs.rs/notify/latest/notify/ — version 8.2.0, released 2025-08-03; cross-platform API confirmed (HIGH confidence)
- https://github.com/tauri-apps/tauri-plugin-fs-watch — confirmed Tauri v1 only, no v2 version (MEDIUM confidence via repo inspection)

---

*Stack research for: Maestro v1.3 — Agents & Worktrees views + on-demand worktree backend*
*Researched: 2026-03-29*
