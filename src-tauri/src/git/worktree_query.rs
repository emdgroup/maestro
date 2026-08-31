use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;

use crate::models::{WorktreeWithStatus, AheadBehind, is_maestro_created_worktree, DiffTarget, WorktreeDiffResult, WorktreeDiffStats, DirtyStatus, CommitInfo};
use crate::core::AppState;

/// Everything one worktree's git state contributes to its card, gathered in a single round trip.
#[derive(Default)]
struct WorktreeGitInfo {
    changed_files_count: u32,
    diff_stat: Option<String>,
    ahead_behind: Option<AheadBehind>,
    commit_count: Option<u32>,
    last_activity_at: Option<String>,
}

/// How many of a worktree's changed files are stat'ed to find the most recent one.
///
/// Bounded because this runs per worktree on a ten-second poll. A tree with more changes than this
/// is already well past the point where the exact minute matters.
const MAX_MTIME_SAMPLES: usize = 200;

/// The working-tree path from one `git status --porcelain` line.
///
/// The format is `XY <path>`, or `XY <old> -> <new>` for a rename. Git quotes paths holding
/// unusual bytes, and those are skipped rather than unquoted: this is only used to stat a file for
/// its modification time, so one skipped file changes nothing unless it is also the newest — a
/// trade worth the escape decoder it saves.
fn porcelain_path(line: &str) -> Option<&str> {
    let rest = line.get(3..)?.trim();
    let path = rest.rsplit(" -> ").next()?;
    (!path.is_empty() && !path.starts_with('"')).then_some(path)
}

/// When a file in this worktree was last modified, taken over the files git reports as changed.
///
/// The worktree directory's own mtime cannot answer this: a directory's mtime moves only when a
/// direct child is added, removed or renamed, and agents edit files several levels down, so it
/// stays frozen at creation. The git index's mtime is worse — it moves when a file goes back to
/// matching the index, which times the wrong event.
///
/// Local connections only. The batch runner speaks git, not shell, so there is no way to stat a
/// remote path in the same round trip; remote worktrees fall back to their last commit's date.
async fn newest_changed_file_at(
    conn: &crate::models::GitConnection,
    worktree_path: &str,
    status_output: &str,
) -> Option<chrono::DateTime<chrono::Utc>> {
    if !matches!(conn, crate::models::GitConnection::Local { .. }) {
        return None;
    }
    let root = std::path::Path::new(worktree_path);
    let mut newest: Option<std::time::SystemTime> = None;
    for line in status_output.lines().take(MAX_MTIME_SAMPLES) {
        let Some(relative) = porcelain_path(line) else {
            continue;
        };
        // A deleted file has no mtime to read, and its `status` line is the only trace left of it.
        let Ok(modified) = tokio::fs::metadata(root.join(relative))
            .await
            .and_then(|metadata| metadata.modified())
        else {
            continue;
        };
        newest = Some(newest.map_or(modified, |current: std::time::SystemTime| current.max(modified)));
    }
    newest.map(chrono::DateTime::<chrono::Utc>::from)
}

fn parse_rfc3339(raw: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(raw.trim())
        .ok()
        .map(|parsed| parsed.with_timezone(&chrono::Utc))
}

/// One worktree's git state, as one batched round trip plus a local stat pass.
///
/// Batched because on WSL/SSH/Docker each git call pays a full interop spawn, and this runs per
/// worktree on a ten-second poll.
async fn git_info_for(
    conn: &crate::models::GitConnection,
    worktree_path: &str,
    base_branch: Option<&str>,
    remote: &str,
) -> (String, WorktreeGitInfo) {
    let mut commands: Vec<Vec<String>> = vec![
        vec!["status".into(), "--porcelain".into()],
        // `diff HEAD`, not a bare `diff`: the latter is the unstaged half only, so a worktree
        // whose changes had all been staged reported "+0 -0" while its file count said otherwise.
        vec!["diff".into(), "HEAD".into(), "--shortstat".into()],
        vec!["rev-list".into(), "--left-right".into(), "--count".into(), "HEAD...@{u}".into()],
        vec!["log".into(), "-1".into(), "--format=%cI".into()],
    ];
    if let Some(base) = base_branch {
        // Local ref before the remote one, the same order `resolve_divergence_point` uses: a
        // worktree is created from a local ref, and a repository with no remote has no
        // `<remote>/<base>` at all. A `base` that is already qualified resolves on the first.
        commands.push(vec!["rev-list".into(), "--count".into(), format!("{}..HEAD", base)]);
        commands.push(vec![
            "rev-list".into(),
            "--count".into(),
            format!("{}/{}..HEAD", remote, base),
        ]);
    }

    let borrowed: Vec<Vec<&str>> = commands
        .iter()
        .map(|command| command.iter().map(String::as_str).collect())
        .collect();
    let as_slices: Vec<&[&str]> = borrowed.iter().map(Vec::as_slice).collect();
    let mut outputs = crate::git::run_git_commands_lossy(conn, worktree_path, &as_slices)
        .await
        .into_iter();

    let status_output = outputs.next().unwrap_or_default();
    let diff_stat_raw = outputs.next().unwrap_or_default();
    let ahead_behind_raw = outputs.next().unwrap_or_default();
    let last_commit_raw = outputs.next().unwrap_or_default();
    let commit_count = base_branch.and_then(|_| {
        let local = outputs.next().unwrap_or_default();
        let from_remote = outputs.next().unwrap_or_default();
        local
            .trim()
            .parse::<u32>()
            .ok()
            .or_else(|| from_remote.trim().parse::<u32>().ok())
    });

    let newest_change = newest_changed_file_at(conn, worktree_path, &status_output).await;
    let last_activity_at = match (newest_change, parse_rfc3339(&last_commit_raw)) {
        (Some(change), Some(commit)) => Some(change.max(commit)),
        (change, commit) => change.or(commit),
    }
    .map(|when| when.to_rfc3339());

    let info = WorktreeGitInfo {
        changed_files_count: status_output.lines().filter(|line| !line.is_empty()).count() as u32,
        diff_stat: (!diff_stat_raw.trim().is_empty()).then(|| diff_stat_raw.trim().to_string()),
        ahead_behind: ahead_behind_raw
            .trim()
            .split_once('\t')
            .and_then(|(ahead, behind)| ahead.parse::<u32>().ok().zip(behind.parse::<u32>().ok()))
            .map(|(ahead, behind)| AheadBehind { ahead, behind }),
        commit_count,
        last_activity_at,
    };
    (worktree_path.to_string(), info)
}

// ============================================================================
// list_worktrees_with_status — REQ-06
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn list_worktrees_with_status(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    repo_path: String,
) -> Result<Vec<WorktreeWithStatus>, String> {
    // Resolve project and git connection (local vs remote SSH)
    let project = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
            [project_id],
            crate::models::Project::from_row,
        ).map_err(|e| format!("Project {} not found: {}", project_id, e))?
    };
    let git_conn = crate::core::get_git_connection(&project, &app_state).await
        .unwrap_or_else(|_| crate::models::GitConnection::Local { path: repo_path.clone() });

    // Step 1: Get on-disk worktrees
    let disk_worktrees = crate::git::list_worktrees(&git_conn).await?;

    // Step 2: No filter — include main worktree (repo root) so it appears in the spawn dialog.

    // Step 3: Query DB for all worktrees for this project, enriched with task/execution info
    struct DbWorktreeRow {
        id: i32,
        project_id: i32,
        task_id: Option<i32>,
        branch_name: String,
        path: String,
        created_at: String,
        base_branch: Option<String>,
        task_name: Option<String>,
    }

    let db_rows: Vec<DbWorktreeRow> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT w.id, w.project_id, w.task_id, w.branch_name, w.path, w.created_at, w.base_branch,
                    t.title AS task_name
             FROM worktrees w
             LEFT JOIN tasks t ON t.id = w.task_id
             WHERE w.project_id = ?"
        ).map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows: Vec<DbWorktreeRow> = stmt
            .query_map(rusqlite::params![project_id], |row| {
                Ok(DbWorktreeRow {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    task_id: row.get(2)?,
                    branch_name: row.get(3)?,
                    path: row.get(4)?,
                    created_at: row.get(5)?,
                    base_branch: row.get(6)?,
                    task_name: row.get(7)?,
                })
            })
            .map_err(|e| format!("Failed to query worktrees: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    // Step 4: Build a HashMap<abs_path, DB row> keyed by absolute path
    let db_map: HashMap<String, &DbWorktreeRow> = db_rows
        .iter()
        .map(|row| {
            let abs_path = format!("{}/{}", repo_path, row.path);
            (abs_path, row)
        })
        .collect();

    // Step 5: Run parallel git status + diff --shortstat + rev-list per on-disk worktree (local AND remote)
    let mut git_info: HashMap<String, WorktreeGitInfo> = HashMap::new();
    {
        // Resolved once for the whole batch. This query refetches every ten seconds, and the
        // per-worktree tasks below would otherwise each pay for the lookup.
        let remote = crate::git::remote::project_remote(&app_state, project_id).await;
        let handles: Vec<_> = disk_worktrees
            .iter()
            .map(|wt| {
                let wt_path = wt.path.clone();
                let conn = git_conn.clone();
                let base_branch = db_map.get(&wt.path).and_then(|row| row.base_branch.clone());
                let remote = remote.clone();
                tokio::spawn(async move {
                    git_info_for(&conn, &wt_path, base_branch.as_deref(), &remote).await
                })
            })
            .collect();

        for handle in handles {
            if let Ok((path, info)) = handle.await {
                git_info.insert(path, info);
            }
        }
    }

    // Step 6: Build WorktreeWithStatus vec
    // Track which DB paths were matched by an on-disk worktree
    let mut matched_db_ids: HashSet<i32> = HashSet::new();
    let mut result: Vec<WorktreeWithStatus> = Vec::new();

    // A session worktree carries no task, so the row alone cannot tell a leftover from one a
    // running session is sitting in.
    let live_cwds = crate::git::worktree_lifecycle::live_session_cwds(&app_state, &project).await;

    for wt in &disk_worktrees {
        let WorktreeGitInfo {
            changed_files_count,
            diff_stat,
            ahead_behind,
            commit_count,
            last_activity_at,
        } = git_info.remove(&wt.path).unwrap_or_default();
        // A worktree with no branch is on a detached HEAD. `branch_name` keeps the recorded name
        // because branch operations still need it, but the card must not present it as checked out.
        let detached_at = wt
            .branch
            .is_none()
            .then(|| wt.head.chars().take(7).collect::<String>());
        if let Some(db_row) = db_map.get(&wt.path) {
            matched_db_ids.insert(db_row.id);
            let in_use = live_cwds
                .iter()
                .any(|cwd| crate::git::worktree_lifecycle::path_is_within(cwd, &wt.path));
            let is_zombie =
                db_row.task_id.is_none() && is_maestro_created_worktree(&db_row.path) && !in_use;
            result.push(WorktreeWithStatus {
                id: Some(db_row.id),
                project_id: Some(db_row.project_id),
                task_id: db_row.task_id,
                // Read from git, not the DB: a checkout inside the worktree moves it off the
                // branch recorded at creation. Detached HEAD keeps the recorded name.
                branch_name: wt.branch.clone().unwrap_or_else(|| db_row.branch_name.clone()),
                path: format!("{}/{}", repo_path, db_row.path),
                changed_files_count,
                created_at: Some(db_row.created_at.clone()),
                task_name: db_row.task_name.clone(),
                is_zombie,
                is_orphan: false,
                diff_stat,
                base_branch: db_row.base_branch.clone(),
                ahead_behind,
                commit_count,
                last_activity_at,
                detached_at,
            });
        } else {
            // On-disk but not in DB — orphan entry
            let branch_name = wt.branch.clone().unwrap_or_else(|| "unknown".to_string());
            result.push(WorktreeWithStatus {
                id: None,
                project_id: None,
                task_id: None,
                branch_name,
                path: wt.path.clone(),
                changed_files_count,
                created_at: None,
                task_name: None,
                is_zombie: false,
                is_orphan: true,
                diff_stat,
                base_branch: None,
                ahead_behind,
                commit_count,
                last_activity_at,
                detached_at,
            });
        }
    }

    // Step 7: Auto-delete DB rows not matched by any on-disk worktree.
    // An empty path is a `create_worktree` reservation whose git worktree is still being created:
    // it cannot match anything on disk yet, and its id is already held by the caller.
    let unmatched_db_ids: Vec<i32> = db_rows
        .iter()
        .filter(|row| !matched_db_ids.contains(&row.id) && !row.path.is_empty())
        .map(|row| row.id)
        .collect();

    if !unmatched_db_ids.is_empty() {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        for id in &unmatched_db_ids {
            let _ = conn.execute("DELETE FROM worktrees WHERE id = ?", [id]);
        }
    }

    // Sort by created_at descending (None goes last)
    result.sort_by(|a, b| {
        match (&b.created_at, &a.created_at) {
            (Some(b_ts), Some(a_ts)) => b_ts.cmp(a_ts),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.path.cmp(&b.path),
        }
    });

    Ok(result)
}

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024; // 2 MB
const MAX_UNTRACKED_FILES: usize = 500;

fn floor_char_boundary(s: &str, mut index: usize) -> usize {
    while index > 0 && !s.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// Resolve the commit a worktree diverged from, given the branch it was created from.
///
/// Tries the local branch before `<remote>/<branch>`: a worktree is created from a local ref, and
/// a repository with no remote at all has no `<remote>/<branch>` to name — which is why the old
/// hardcoded `origin/` prefix failed outright there rather than degrading. A `branch` that is
/// already remote-qualified resolves on the first candidate.
///
/// Returns the merge base rather than the branch tip so that commits the base branch gained
/// *after* this worktree diverged do not appear in the diff as reversed changes.
async fn resolve_divergence_point(
    git_conn: &crate::models::GitConnection,
    worktree_path: &str,
    branch: &str,
    remote: &str,
) -> Result<String, String> {
    for candidate in [branch.to_string(), format!("{}/{}", remote, branch)] {
        if let Ok(output) =
            crate::git::run_git_in_dir(git_conn, worktree_path, &["merge-base", &candidate, "HEAD"])
                .await
        {
            let sha = output.trim();
            if !sha.is_empty() {
                return Ok(sha.to_string());
            }
        }
    }

    Err(format!(
        "Could not find where this worktree diverged from '{}'. Neither '{}' nor '{}/{}' \
         resolves to a commit shared with HEAD.",
        branch, branch, remote, branch
    ))
}

/// The revision a `DiffTarget` compares *from* — the "old" side of every hunk it produces.
///
/// This is what `git show <rev>:<path>` has to be given to recover the pre-image of a file, so it
/// must stay in step with the commands `get_worktree_diff` below actually runs. A mismatch does
/// not fail loudly: the blob would simply not match the diff, and the diff view would expand to
/// lines that were never in the file being reviewed.
async fn base_rev_for(
    git_conn: &crate::models::GitConnection,
    worktree_path: &str,
    diff_target: &DiffTarget,
    remote: &str,
) -> Result<String, String> {
    match diff_target {
        DiffTarget::Head => Ok("HEAD".to_string()),
        DiffTarget::Commit { sha } => Ok(sha.clone()),
        DiffTarget::BranchAll { branch } => {
            resolve_divergence_point(git_conn, worktree_path, branch, remote).await
        }
        // `from` is the range's base, so it is the pre-image even though `to` is what moved.
        DiffTarget::CommitRange { from, .. } => Ok(from.clone()),
    }
}

/// Whether a `DiffTarget` compares against the working tree, and so whether untracked files are
/// part of what it shows.
///
/// A commit range ends at a commit: a file git has never been told about cannot be in it, and
/// listing one there put files in front of the reviewer that the selected commit does not contain.
/// The other three all diff *to* the working tree, where a file that is new and not yet added is
/// as much part of the change as an edited one.
fn includes_working_tree(diff_target: &DiffTarget) -> bool {
    !matches!(diff_target, DiffTarget::CommitRange { .. })
}

/// The worktree's untracked files, or nothing when the target does not reach the working tree.
async fn untracked_files_for(
    git_conn: &crate::models::GitConnection,
    worktree_path: &str,
    diff_target: &DiffTarget,
) -> Vec<String> {
    if !includes_working_tree(diff_target) {
        return Vec::new();
    }
    crate::git::run_git_in_dir(
        git_conn,
        worktree_path,
        &["ls-files", "--others", "--exclude-standard"],
    )
    .await
    .unwrap_or_default()
    .lines()
    .filter(|line| !line.is_empty())
    .map(String::from)
    .collect()
}

// ============================================================================
// get_worktree_diff — REQ-07
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn get_worktree_diff(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    diff_target: DiffTarget,
) -> Result<WorktreeDiffResult, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    let diff_output = match &diff_target {
        DiffTarget::Head => {
            crate::git::run_git_in_dir(&git_conn, &worktree_path, &["diff", "HEAD"]).await?
        }
        DiffTarget::Commit { sha } => {
            crate::git::run_git_in_dir(&git_conn, &worktree_path, &["diff", "--unified=6", sha]).await?
        }
        DiffTarget::BranchAll { branch } => {
            let remote = crate::git::remote::project_remote(&app_state, project_id).await;
            let base = resolve_divergence_point(&git_conn, &worktree_path, branch, &remote).await?;
            crate::git::run_git_in_dir(&git_conn, &worktree_path, &["diff", "--unified=6", &base]).await?
        }
        DiffTarget::CommitRange { from, to } => {
            let range = format!("{}..{}", from, to);
            crate::git::run_git_in_dir(&git_conn, &worktree_path, &["diff", "--unified=6", &range]).await?
        }
    };

    let all_untracked = untracked_files_for(&git_conn, &worktree_path, &diff_target).await;

    let total_diff_bytes = diff_output.len();
    let diff_truncated = total_diff_bytes > MAX_DIFF_BYTES;
    let diff = if diff_truncated {
        let cut = floor_char_boundary(&diff_output, MAX_DIFF_BYTES);
        // Cut on a file boundary: a diff sliced mid-hunk parses into a corrupt trailing file
        // rather than one fewer file.
        let cut = diff_output[..cut]
            .rfind("\ndiff --git")
            .map(|index| index + 1)
            .unwrap_or(cut);
        diff_output[..cut].to_string()
    } else {
        diff_output
    };

    let total_untracked = all_untracked.len();
    let untracked_truncated = total_untracked > MAX_UNTRACKED_FILES;
    let untracked_files = if untracked_truncated {
        all_untracked.into_iter().take(MAX_UNTRACKED_FILES).collect()
    } else {
        all_untracked
    };

    Ok(WorktreeDiffResult {
        diff,
        diff_truncated,
        total_diff_bytes,
        untracked_files,
        untracked_truncated,
        total_untracked,
    })
}

// ============================================================================
// get_worktree_diff_stats — lightweight stats for session header display
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn get_worktree_diff_stats(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    diff_target: DiffTarget,
) -> Result<WorktreeDiffStats, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let remote = crate::git::remote::project_remote(&app_state, project_id).await;
    diff_stats_in(&git_conn, &worktree_path, &diff_target, &remote).await
}

/// The body of `get_worktree_diff_stats`, callable without going through the Tauri command.
///
/// Split out so the turn-ended handler can ask whether an agent actually changed anything before
/// deciding a turn ending means the work is finished.
pub async fn diff_stats_in(
    git_conn: &crate::models::GitConnection,
    worktree_path: &str,
    diff_target: &DiffTarget,
    remote: &str,
) -> Result<WorktreeDiffStats, String> {
    // Must resolve the same way `get_worktree_diff` does, or the stats and the diff disagree —
    // and these stats are what the turn-ended handler uses to decide whether an agent changed
    // anything at all.
    let stat_args: Vec<String> = match diff_target {
        DiffTarget::Head => vec!["diff".into(), "--stat".into(), "HEAD".into()],
        DiffTarget::Commit { sha } => vec!["diff".into(), "--stat".into(), sha.clone()],
        DiffTarget::BranchAll { branch } => {
            let base = resolve_divergence_point(git_conn, worktree_path, branch, remote).await?;
            vec!["diff".into(), "--stat".into(), base]
        }
        DiffTarget::CommitRange { from, to } => vec!["diff".into(), "--stat".into(), format!("{}..{}", from, to)],
    };
    let stat_args_ref: Vec<&str> = stat_args.iter().map(String::as_str).collect();

    let stat_output = crate::git::run_git_in_dir(git_conn, worktree_path, &stat_args_ref)
        .await
        .unwrap_or_default();

    let (mut file_count, mut insertions, mut deletions) = (0u32, 0u32, 0u32);
    // The last non-empty line of `git diff --stat` is the summary, e.g.:
    // " 3 files changed, 42 insertions(+), 7 deletions(-)"
    if let Some(summary) = stat_output.lines().rfind(|l| !l.trim().is_empty()) {
        for part in summary.split(',') {
            let part = part.trim();
            if part.contains("file") {
                file_count = part.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
            } else if part.contains("insertion") {
                insertions = part.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
            } else if part.contains("deletion") {
                deletions = part.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
            }
        }
    }

    let untracked_count =
        untracked_files_for(git_conn, worktree_path, diff_target).await.len() as u32;

    Ok(WorktreeDiffStats { file_count, insertions, deletions, untracked_count })
}

impl WorktreeDiffStats {
    /// Whether the agent changed anything at all — tracked edits or new files.
    pub fn has_changes(&self) -> bool {
        self.file_count > 0 || self.untracked_count > 0
    }
}

// ============================================================================
// check_worktree_dirty — Review State Phase 1
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn check_worktree_dirty(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
) -> Result<DirtyStatus, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    let output = crate::git::run_git_in_dir(&git_conn, &worktree_path, &["status", "--porcelain"]).await?;

    let mut modified_count: u32 = 0;
    let mut untracked_count: u32 = 0;
    for line in output.lines() {
        if line.starts_with("??") {
            untracked_count += 1;
        } else if line.len() >= 2 {
            modified_count += 1;
        }
    }

    Ok(DirtyStatus { modified_count, untracked_count })
}

// ============================================================================
// get_worktree_commits — Review State Phase 1
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn get_worktree_commits(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    base_branch: String,
) -> Result<Vec<CommitInfo>, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    let merge_base = crate::git::run_git_in_dir(
        &git_conn, &worktree_path, &["merge-base", &base_branch, "HEAD"],
    ).await.unwrap_or_default();

    let range = if merge_base.trim().is_empty() {
        format!("{}..HEAD", base_branch)
    } else {
        format!("{}..HEAD", merge_base.trim())
    };

    let log_output = crate::git::run_git_in_dir(
        &git_conn,
        &worktree_path,
        &["log", "--format=%H %cI %s", &range],
    ).await.unwrap_or_default();

    Ok(parse_commit_log(&log_output))
}

/// Parse `git log --format=%H %cI %s` output.
///
/// The subject is taken as the rest of the line rather than split further, so a message containing
/// spaces — or something that looks like a timestamp — survives intact.
fn parse_commit_log(log_output: &str) -> Vec<CommitInfo> {
    log_output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut parts = line.splitn(3, ' ');
            CommitInfo {
                sha: parts.next().unwrap_or_default().to_string(),
                committed_at: parts.next().unwrap_or_default().to_string(),
                message: parts.next().unwrap_or_default().to_string(),
            }
        })
        .collect()
}

// ============================================================================
// get_untracked_file_content — returns file content as a unified diff string
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn get_untracked_file_content(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    file_path: String,
) -> Result<String, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    crate::git::run_git_in_dir_lossy(
        &git_conn,
        &worktree_path,
        &["diff", "--no-index", "/dev/null", &file_path],
    )
    .await
}

// ============================================================================
// get_file_content_at_base — the pre-image of one file, for diff hunk expansion
// ============================================================================

/// Beyond this a blob is not worth shipping: the diff view skips syntax highlighting past 2000
/// lines anyway, and the whole point of fetching it is to render it.
const MAX_BLOB_BYTES: usize = 2 * 1024 * 1024;

/// One file's contents at the revision a diff was taken from.
///
/// `@git-diff-view` can only offer its hunk-expansion controls when it holds a full copy of one
/// side of the file; given the old side it reconstructs the new one from the hunks. This is
/// fetched per file, when the user asks to expand, because attaching it to every file in a review
/// costs a whole-file syntax highlight per card and that is what makes scrolling a large review
/// stutter.
///
/// `Ok(None)` rather than an error for anything unusable — a path absent at the base (an added
/// file, or a rename whose pre-image is under its old name), or a blob past the size cap. The
/// caller renders exactly what it renders today when there is no content, so a miss costs the
/// expansion controls rather than the diff.
#[tauri::command]
#[specta::specta]
pub async fn get_file_content_at_base(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    diff_target: DiffTarget,
    file_path: String,
) -> Result<Option<String>, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let remote = crate::git::remote::project_remote(&app_state, project_id).await;
    let base = base_rev_for(&git_conn, &worktree_path, &diff_target, &remote).await?;
    Ok(file_content_at(&git_conn, &worktree_path, &base, &file_path).await)
}

async fn file_content_at(
    git_conn: &crate::models::GitConnection,
    worktree_path: &str,
    base: &str,
    file_path: &str,
) -> Option<String> {
    // `git show` exits non-zero for a path the revision does not have, which is an expected answer
    // here rather than a failure, so the error becomes None instead of propagating.
    let object = format!("{}:{}", base, file_path);
    let content = crate::git::run_git_in_dir(git_conn, worktree_path, &["show", &object])
        .await
        .ok()?;
    (content.len() <= MAX_BLOB_BYTES).then_some(content)
}

#[cfg(test)]
mod commit_log_tests {
    use super::parse_commit_log;

    #[test]
    fn parses_sha_date_and_subject() {
        let commits = parse_commit_log("abc123 2026-08-26T14:15:22+00:00 Retire legacy module\n");
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].sha, "abc123");
        assert_eq!(commits[0].committed_at, "2026-08-26T14:15:22+00:00");
        assert_eq!(commits[0].message, "Retire legacy module");
    }

    // The subject is the rest of the line, not a third space-delimited field — otherwise every
    // message longer than one word would be truncated.
    #[test]
    fn keeps_a_subject_that_looks_like_more_fields() {
        let commits =
            parse_commit_log("abc123 2026-08-26T14:15:22+00:00 Fix 2026-01-01T00:00:00Z parsing");
        assert_eq!(commits[0].message, "Fix 2026-01-01T00:00:00Z parsing");
    }

    #[test]
    fn tolerates_an_empty_subject() {
        let commits = parse_commit_log("abc123 2026-08-26T14:15:22+00:00 ");
        assert_eq!(commits[0].sha, "abc123");
        assert_eq!(commits[0].message, "");
    }

    #[test]
    fn skips_blank_lines_and_empty_output() {
        assert!(parse_commit_log("").is_empty());
        assert!(parse_commit_log("\n  \n").is_empty());
        assert_eq!(parse_commit_log("a 2026-01-01T00:00:00Z m\n\n").len(), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::GitConnection;
    use std::path::Path;
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(repo)
            .args(args)
            .output()
            .unwrap_or_else(|e| panic!("git {:?} failed to run: {}", args, e));
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    /// Pins both halves of the bug this replaced.
    ///
    /// The repository has **no remote**, so the old hardcoded `origin/<branch>` could not resolve
    /// at all. And the base branch moves forward after the worktree diverges, so returning the
    /// branch tip rather than the merge base would drag main's later commit into the diff as a
    /// reversed change.
    #[tokio::test]
    async fn divergence_point_is_the_merge_base_of_a_local_branch() {
        let temp = tempfile::tempdir().expect("create temporary repository");
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "Maestro Test"]);
        git(repo, &["config", "user.email", "maestro@example.test"]);
        git(repo, &["config", "commit.gpgsign", "false"]);
        git(repo, &["config", "core.hooksPath", ""]);

        std::fs::write(repo.join("a.txt"), "base\n").expect("write base file");
        git(repo, &["add", "a.txt"]);
        git(repo, &["commit", "-m", "base"]);
        let divergence = git(repo, &["rev-parse", "HEAD"]);

        git(repo, &["checkout", "-b", "task-1"]);
        std::fs::write(repo.join("b.txt"), "task\n").expect("write task file");
        git(repo, &["add", "b.txt"]);
        git(repo, &["commit", "-m", "task change"]);

        // main moves on after we branched. The tip is now wrong; the merge base is still `base`.
        git(repo, &["checkout", "main"]);
        std::fs::write(repo.join("c.txt"), "main\n").expect("write main file");
        git(repo, &["add", "c.txt"]);
        git(repo, &["commit", "-m", "main change"]);
        let main_tip = git(repo, &["rev-parse", "HEAD"]);

        git(repo, &["checkout", "task-1"]);

        let connection = GitConnection::Local {
            path: repo.to_string_lossy().into_owned(),
        };
        let resolved = resolve_divergence_point(&connection, &repo.to_string_lossy(), "main", "origin")
            .await
            .expect("a local branch with no remote must still resolve");

        assert_eq!(resolved, divergence, "must be the merge base, not the branch tip");
        assert_ne!(resolved, main_tip);
    }

    #[tokio::test]
    async fn divergence_point_reports_an_unresolvable_branch() {
        let temp = tempfile::tempdir().expect("create temporary repository");
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "Maestro Test"]);
        git(repo, &["config", "user.email", "maestro@example.test"]);
        git(repo, &["config", "commit.gpgsign", "false"]);
        git(repo, &["config", "core.hooksPath", ""]);
        std::fs::write(repo.join("a.txt"), "base\n").expect("write base file");
        git(repo, &["add", "a.txt"]);
        git(repo, &["commit", "-m", "base"]);

        let connection = GitConnection::Local {
            path: repo.to_string_lossy().into_owned(),
        };
        let error = resolve_divergence_point(&connection, &repo.to_string_lossy(), "no-such-branch", "origin")
            .await
            .expect_err("an unknown branch must not silently resolve");

        assert!(error.contains("no-such-branch"), "error should name the branch: {}", error);
    }

    /// A repository with one commit on `main` and one on `task`, so every `DiffTarget` variant has
    /// a distinct correct answer and a variant returning the wrong one cannot pass by coincidence.
    fn repo_with_two_commits(repo: &Path) -> (String, String) {
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "Maestro Test"]);
        git(repo, &["config", "user.email", "maestro@example.test"]);
        git(repo, &["config", "commit.gpgsign", "false"]);
        git(repo, &["config", "core.hooksPath", ""]);

        std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").expect("write base file");
        git(repo, &["add", "a.txt"]);
        git(repo, &["commit", "-m", "base"]);
        let base = git(repo, &["rev-parse", "HEAD"]);

        git(repo, &["checkout", "-b", "task"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo CHANGED\nthree\n").expect("write task file");
        std::fs::write(repo.join("added.txt"), "new\n").expect("write added file");
        git(repo, &["add", "."]);
        git(repo, &["commit", "-m", "task change"]);
        let tip = git(repo, &["rev-parse", "HEAD"]);

        (base, tip)
    }

    #[tokio::test]
    async fn base_rev_matches_what_each_diff_target_diffs_from() {
        let temp = tempfile::tempdir().expect("create temporary repository");
        let repo = temp.path();
        let (base, tip) = repo_with_two_commits(repo);
        let path = repo.to_string_lossy().into_owned();
        let connection = GitConnection::Local { path: path.clone() };

        let resolve = |target: DiffTarget| {
            let connection = connection.clone();
            let path = path.clone();
            async move { base_rev_for(&connection, &path, &target, "origin").await }
        };

        assert_eq!(resolve(DiffTarget::Head).await.expect("HEAD resolves"), "HEAD");
        assert_eq!(
            resolve(DiffTarget::Commit { sha: base.clone() }).await.expect("a sha resolves"),
            base
        );
        assert_eq!(
            resolve(DiffTarget::BranchAll { branch: "main".to_string() })
                .await
                .expect("a branch resolves through its merge base"),
            base
        );
        // The range's pre-image is `from`, not `to` — reversing them would expand to the wrong side.
        assert_eq!(
            resolve(DiffTarget::CommitRange { from: base.clone(), to: tip })
                .await
                .expect("a range resolves"),
            base
        );
    }

    /// The scope selector's commit rows map to `CommitRange`, and those used to be handed the same
    /// `ls-files --others` output as every other scope — so picking a commit listed files that
    /// commit does not contain and never did. The other three targets all diff *to* the working
    /// tree, where an untracked file genuinely is part of what changed, so they must keep it.
    #[tokio::test]
    async fn untracked_files_belong_only_to_targets_that_reach_the_working_tree() {
        let temp = tempfile::tempdir().expect("create temporary repository");
        let repo = temp.path();
        let (base, tip) = repo_with_two_commits(repo);
        let path = repo.to_string_lossy().into_owned();
        let connection = GitConnection::Local { path: path.clone() };

        std::fs::write(repo.join("scratch.txt"), "never added\n").expect("write untracked file");
        let expected = vec!["scratch.txt".to_string()];

        let untracked = |target: DiffTarget| {
            let connection = connection.clone();
            let path = path.clone();
            async move { untracked_files_for(&connection, &path, &target).await }
        };

        assert_eq!(untracked(DiffTarget::Head).await, expected);
        assert_eq!(untracked(DiffTarget::Commit { sha: base.clone() }).await, expected);
        assert_eq!(
            untracked(DiffTarget::BranchAll { branch: "main".to_string() }).await,
            expected
        );
        assert!(
            untracked(DiffTarget::CommitRange { from: base, to: tip }).await.is_empty(),
            "a commit range ends at a commit and cannot contain a file git has never seen"
        );
    }

    #[test]
    fn porcelain_paths_are_read_from_the_status_line() {
        assert_eq!(porcelain_path(" M src/main.rs"), Some("src/main.rs"));
        assert_eq!(porcelain_path("?? scratch.txt"), Some("scratch.txt"));
        // A rename's path is the new name; the old one no longer exists to stat.
        assert_eq!(porcelain_path("R  old.rs -> new.rs"), Some("new.rs"));
        // Quoted paths are skipped rather than unquoted — see `porcelain_path`.
        assert_eq!(porcelain_path("?? \"caf\\303\\251.ts\""), None);
        assert_eq!(porcelain_path("XY"), None);
    }

    /// The card's `+/-` came from a bare `git diff --shortstat`, which is the *unstaged* half only.
    /// An agent that staged its work — or anything run after `git add` — reported "+0 -0" while the
    /// changed-file count beside it said otherwise.
    #[tokio::test]
    async fn diff_stat_counts_staged_changes_too() {
        let temp = tempfile::tempdir().expect("create temporary repository");
        let repo = temp.path();
        repo_with_two_commits(repo);
        let path = repo.to_string_lossy().into_owned();
        let connection = GitConnection::Local { path: path.clone() };

        std::fs::write(repo.join("a.txt"), "one\ntwo CHANGED\nthree\nfour\n").expect("edit file");
        git(repo, &["add", "a.txt"]);

        let (_, info) = git_info_for(&connection, &path, None, "origin").await;
        let stat = info.diff_stat.expect("a staged change is still a change");
        assert!(stat.contains("insertion"), "staged insertions must be counted, got {stat:?}");
    }

    /// The commit count is what the card shows as the work done here, so it must be measured
    /// against the base branch — and must not drift when the base branch moves on afterwards.
    #[tokio::test]
    async fn commit_count_is_this_branch_s_own_commits() {
        let temp = tempfile::tempdir().expect("create temporary repository");
        let repo = temp.path();
        repo_with_two_commits(repo);
        let path = repo.to_string_lossy().into_owned();
        let connection = GitConnection::Local { path: path.clone() };

        let (_, info) = git_info_for(&connection, &path, Some("main"), "origin").await;
        assert_eq!(info.commit_count, Some(1), "one commit since main");

        // main gaining a commit of its own must not change how much work this branch has.
        git(repo, &["checkout", "main"]);
        std::fs::write(repo.join("c.txt"), "main\n").expect("write main file");
        git(repo, &["add", "c.txt"]);
        git(repo, &["commit", "-m", "main moves on"]);
        git(repo, &["checkout", "task"]);

        let (_, info) = git_info_for(&connection, &path, Some("main"), "origin").await;
        assert_eq!(info.commit_count, Some(1));

        let (_, info) = git_info_for(&connection, &path, None, "origin").await;
        assert_eq!(info.commit_count, None, "nothing to count against without a base branch");
    }

    /// A clean worktree falls back to its last commit; a dirty one reports the edit, which is later.
    #[tokio::test]
    async fn last_activity_prefers_a_working_tree_edit_over_the_last_commit() {
        let temp = tempfile::tempdir().expect("create temporary repository");
        let repo = temp.path();
        repo_with_two_commits(repo);
        let path = repo.to_string_lossy().into_owned();
        let connection = GitConnection::Local { path: path.clone() };

        let (_, clean) = git_info_for(&connection, &path, None, "origin").await;
        let committed = clean.last_activity_at.expect("a clean worktree still has a last commit");

        std::fs::write(repo.join("a.txt"), "edited after the commit\n").expect("edit file");
        let (_, dirty) = git_info_for(&connection, &path, None, "origin").await;
        let edited = dirty.last_activity_at.expect("a dirty worktree reports its newest edit");

        assert!(
            parse_rfc3339(&edited) >= parse_rfc3339(&committed),
            "{edited} should not predate {committed}"
        );
    }

    #[tokio::test]
    async fn file_content_at_reads_the_pre_image_not_the_working_tree() {
        let temp = tempfile::tempdir().expect("create temporary repository");
        let repo = temp.path();
        let (base, _tip) = repo_with_two_commits(repo);
        let path = repo.to_string_lossy().into_owned();
        let connection = GitConnection::Local { path: path.clone() };

        let content = file_content_at(&connection, &path, &base, "a.txt")
            .await
            .expect("the file exists at the base commit");
        assert_eq!(content, "one\ntwo\nthree\n", "must be the blob at the base, not HEAD's");
    }

    /// A file added on the branch has no pre-image, and neither does a rename's post-image path.
    /// Both must degrade to "no expansion available" rather than failing the whole request.
    #[tokio::test]
    async fn file_content_at_returns_none_for_a_path_absent_at_the_base() {
        let temp = tempfile::tempdir().expect("create temporary repository");
        let repo = temp.path();
        let (base, _tip) = repo_with_two_commits(repo);
        let path = repo.to_string_lossy().into_owned();
        let connection = GitConnection::Local { path: path.clone() };

        assert!(file_content_at(&connection, &path, &base, "added.txt").await.is_none());
        assert!(file_content_at(&connection, &path, &base, "never-existed.txt").await.is_none());
    }
}
