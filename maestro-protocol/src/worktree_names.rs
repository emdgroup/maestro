//! Where Maestro puts the worktrees it makes and what it names their branches. The app creates and
//! sweeps some of them and the daemon others, and each side has to recognise the other's, so the
//! names are decided here once.

/// Every worktree Maestro creates lives in this directory, relative to the repository root.
pub const WORKTREE_DIR: &str = ".maestro/worktrees";
/// A task's worktree: `task-<task id>`.
pub const WORKTREE_PATH_PREFIX: &str = ".maestro/worktrees/task-";
/// A session's worktree: `session-<worktree row id>`.
pub const WORKTREE_SESSION_PATH_PREFIX: &str = ".maestro/worktrees/session-";
/// A loop's sandbox directory name: `loop-<task id>`.
const LOOP_SANDBOX_PREFIX: &str = "loop-";

/// Namespace every branch Maestro creates for itself lives under: sessions from
/// `SpawnSessionDialog` and tasks from `useExecuteTask`, both through `MAESTRO_BRANCH_PREFIX`
/// in `generateSessionName.ts`, and every task and automation branch the daemon makes.
///
/// This prefix is the entire basis on which the app's `list_prunable_branches` may delete a
/// branch. A branch outside it is indistinguishable from one the user made by hand, so it is
/// never a candidate; anything a future feature creates inside it becomes prunable the moment it
/// does.
pub const MAESTRO_BRANCH_PREFIX: &str = "maestro/";

/// The relative worktree path for a given task id.
pub fn worktree_path_for_task(task_id: i32) -> String {
    format!("{WORKTREE_PATH_PREFIX}{task_id}")
}

/// The relative worktree path for a session-owned worktree, keyed by its row id.
pub fn worktree_path_for_session(worktree_id: i32) -> String {
    format!("{WORKTREE_SESSION_PATH_PREFIX}{worktree_id}")
}

/// Where a loop's sandbox goes: a second worktree of the task's, where its worker and its judge
/// work without the sealed files. Not named `task-`, so the app's sweeps never take it for a
/// task's.
pub fn loop_sandbox_path(task_id: i32) -> String {
    format!("{WORKTREE_DIR}/{LOOP_SANDBOX_PREFIX}{task_id}")
}

/// The task a directory under [`WORKTREE_DIR`] is the loop sandbox of, from its name alone.
pub fn loop_sandbox_task_id(dir_name: &str) -> Option<i32> {
    dir_name.strip_prefix(LOOP_SANDBOX_PREFIX)?.parse().ok()
}

/// Where one automation run's worktree goes, relative to the repository root.
pub fn automation_worktree_path(slug: &str, ordinal: i64) -> String {
    format!("{WORKTREE_DIR}/automation-{slug}-{ordinal}")
}

/// The branch an automation run's worktree is created on.
pub fn automation_branch_name(slug: &str, ordinal: i64) -> String {
    format!("{MAESTRO_BRANCH_PREFIX}automation-{slug}-{ordinal}")
}

/// Whether `path`, as git lists it, is a loop's sandbox: the daemon's own second worktree of a loop
/// task, where its worker runs without the sealed files. Never shown: the task's worktree is the one
/// the user works with.
pub fn is_loop_sandbox(path: &str) -> bool {
    let path = path.replace('\\', "/");
    path.rsplit_once('/').is_some_and(|(parent, name)| {
        parent.ends_with(WORKTREE_DIR) && name.starts_with(LOOP_SANDBOX_PREFIX)
    })
}

/// True when Maestro created this worktree itself rather than the user creating it by hand.
///
/// Rows written before the id-based session path existed use a branch-name-derived path and
/// therefore read as user-made. That is deliberate: automatic deletion is the destructive
/// direction, so an unrecognised path must fall on the "keep" side. An automation's worktree does
/// not match either, which is also deliberate: the app's zombie sweep must not reap one the daemon
/// owns.
pub fn is_maestro_created_worktree(relative_path: &str) -> bool {
    relative_path.starts_with(WORKTREE_PATH_PREFIX)
        || relative_path.starts_with(WORKTREE_SESSION_PATH_PREFIX)
}

/// True when another ref already contains the worktree's tip, i.e. the branch holds no commits
/// of its own. `containing` is `git branch --all --contains HEAD --format=%(refname:short)`;
/// `--all` matters because the base branch may have been a remote-tracking ref with no local
/// branch at that commit, and a pushed branch counts as held by its remote ref.
pub fn tip_contained_elsewhere(containing: &str, branch: &str) -> bool {
    containing
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // A detached worktree prints this instead of a name, and it is not another ref.
        .filter(|line| !line.starts_with("(HEAD detached"))
        .any(|line| line != branch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_worktree_is_named_under_the_one_directory() {
        assert_eq!(worktree_path_for_task(4), ".maestro/worktrees/task-4");
        assert_eq!(worktree_path_for_session(3), ".maestro/worktrees/session-3");
        assert_eq!(loop_sandbox_path(7), ".maestro/worktrees/loop-7");
        assert_eq!(
            automation_worktree_path("audit", 3),
            ".maestro/worktrees/automation-audit-3"
        );
        assert_eq!(
            automation_branch_name("audit", 3),
            "maestro/automation-audit-3"
        );
    }

    #[test]
    fn only_maestro_conventions_count_as_auto_created() {
        assert!(is_maestro_created_worktree(&worktree_path_for_task(7)));
        assert!(is_maestro_created_worktree(&worktree_path_for_session(7)));
        // A hand-made worktree, and the pre-id name-based session path: both must read as
        // user-made so cleanup leaves them alone.
        assert!(!is_maestro_created_worktree("../scratch"));
        assert!(!is_maestro_created_worktree(
            ".maestro/worktrees/maestro/hardy-anchor"
        ));
        // A loop's sandbox and an automation's worktree are the daemon's, never swept by the app.
        assert!(!is_maestro_created_worktree(&loop_sandbox_path(7)));
        assert!(!is_maestro_created_worktree(&automation_worktree_path(
            "a", 1
        )));
    }

    #[test]
    fn a_loop_sandbox_is_recognised_by_path_and_by_name() {
        assert!(is_loop_sandbox("C:/repo/.maestro/worktrees/loop-7"));
        assert!(is_loop_sandbox(r"C:\repo\.maestro\worktrees\loop-7"));
        assert!(!is_loop_sandbox("/repo/.maestro/worktrees/task-7"));
        assert!(!is_loop_sandbox("/repo/loop-7"));
        assert_eq!(loop_sandbox_task_id("loop-12"), Some(12));
        assert_eq!(loop_sandbox_task_id("loop-x"), None);
        assert_eq!(loop_sandbox_task_id("task-12"), None);
    }

    #[test]
    fn a_tip_only_its_own_branch_contains_is_worth_keeping() {
        let branch = "maestro/automation-audit-3";
        // Nothing else has these commits.
        assert!(!tip_contained_elsewhere(branch, branch));
        assert!(!tip_contained_elsewhere(&format!("{branch}\n"), branch));
        assert!(!tip_contained_elsewhere("", branch));
        // Merged into main, or pushed and therefore on the remote ref.
        assert!(tip_contained_elsewhere(
            &format!("{branch}\nmain\n"),
            branch
        ));
        assert!(tip_contained_elsewhere(
            &format!("{branch}\norigin/{branch}"),
            branch
        ));
        // A detached head is not another ref holding the work.
        assert!(!tip_contained_elsewhere(
            "(HEAD detached at 1a2b3c4)\n",
            branch
        ));
        assert!(tip_contained_elsewhere(
            "(HEAD detached at 1a2b3c4)\nmain\n",
            branch
        ));
    }
}
