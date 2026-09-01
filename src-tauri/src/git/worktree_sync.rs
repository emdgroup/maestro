use std::sync::Arc;
use tauri::{Emitter, State};

use crate::core::AppState;
use crate::models::GitConnection;

/// Rewrite the git failures a user can act on, and pass everything else through.
///
/// Only the cases where git's own wording describes the mechanism rather than the way out are
/// touched. A credential failure, an unreachable host and a pre-push hook rejection all reach the
/// user verbatim, because git says something specific and we would only be able to say something
/// vaguer.
fn classify_git_failure(stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();

    if lower.contains("[rejected]")
        && (lower.contains("non-fast-forward") || lower.contains("fetch first"))
    {
        return "The remote has commits this branch does not. Pull first, then push again. \
                Maestro never force-pushes."
            .to_string();
    }

    if lower.contains("not possible to fast-forward") || lower.contains("diverging branches") {
        return "This branch and its remote have both moved on, so there is no fast-forward to \
                take. Rebase or merge it in a terminal. Maestro will not leave a worktree \
                mid-merge."
            .to_string();
    }

    if lower.contains("no upstream") || lower.contains("does not appear to be a git repository") {
        return "This branch is not tracking anything on the remote. Publish it first.".to_string();
    }

    stderr.trim().to_string()
}

/// The remote this project pushes to, once it is known to exist.
///
/// `project_remote` falls back to `origin` for a repository that has no remote at all, so its
/// answer alone is not enough — pushing to a name nothing is configured for fails with a message
/// about a repository rather than about the missing remote.
async fn resolve_existing_remote(
    app_state: &AppState,
    project_id: i32,
    git_conn: &GitConnection,
    project_path: &str,
) -> Result<String, String> {
    let remote = crate::git::remote::project_remote(app_state, project_id).await;
    let listed = crate::git::run_git_in_dir_lossy(git_conn, project_path, &["remote", "-v"])
        .await
        .unwrap_or_default();
    if crate::git::remote::url_for_remote(&listed, &remote).is_none() {
        return Err("This project has no git remote, so there is nothing to push to.".to_string());
    }
    Ok(remote)
}

/// Push one worktree's branch to the project's remote, setting it as the upstream.
///
/// Delegates to [`crate::git::push_branch`], which is also what the task-approve path uses — the
/// push therefore runs on the machine that owns the repository and with that machine's credentials,
/// and cannot hang waiting for one.
#[tauri::command]
#[specta::specta]
pub async fn push_worktree_branch(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    branch_name: String,
) -> Result<(), String> {
    let (project, git_conn) =
        crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let remote =
        resolve_existing_remote(&app_state, project_id, &git_conn, &project.path).await?;

    crate::git::push_branch(&git_conn, &worktree_path, &remote, &branch_name)
        .await
        .map_err(|e| classify_git_failure(&e))?;

    app_state.app_handle.emit("worktrees-changed", ()).ok();
    Ok(())
}

/// Fast-forward one worktree onto its upstream, fetching first.
///
/// Fast-forward only, and that is the whole design: `merge --ff-only` either moves the branch or
/// refuses without having written anything, so a pull can never strand a worktree in a conflicted
/// merge that Maestro has no UI to finish. A diverged branch is reported and left alone.
///
/// The fetch carries no refspec, so every `<remote>/*` tracking ref is refreshed — the behind
/// counts on *all* the cards become accurate, not just this one's, and nothing else in the app
/// ever fetches.
///
/// The merge targets `@{u}` rather than `<remote>/<branch>` so it moves onto exactly the ref the
/// card's ahead/behind counts were measured against.
#[tauri::command]
#[specta::specta]
pub async fn pull_worktree_branch(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
) -> Result<(), String> {
    let (project, git_conn) =
        crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let remote =
        resolve_existing_remote(&app_state, project_id, &git_conn, &project.path).await?;

    crate::git::run_git_in_dir(&git_conn, &worktree_path, &["fetch", &remote])
        .await
        .map_err(|e| classify_git_failure(&e))?;

    // Emitted even when the merge below fails: the fetch already moved the tracking refs, so every
    // card's behind count is now stale in the other direction — showing 0 for work that has
    // arrived. The user is about to be told the merge failed; the counts should agree with that.
    app_state.app_handle.emit("worktrees-changed", ()).ok();

    crate::git::run_git_in_dir(&git_conn, &worktree_path, &["merge", "--ff-only", "@{u}"])
        .await
        .map_err(|e| classify_git_failure(&e))?;

    app_state.app_handle.emit("worktrees-changed", ()).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rejected_push_is_reworded_as_pull_first() {
        let stderr = " ! [rejected]        feat/x -> feat/x (fetch first)\n\
                       error: failed to push some refs to 'github.com:me/repo.git'";
        assert!(classify_git_failure(stderr).contains("Pull first"));

        let non_ff = " ! [rejected]        feat/x -> feat/x (non-fast-forward)";
        assert!(classify_git_failure(non_ff).contains("Pull first"));
    }

    /// The rejection wording alone is not enough — a deleted-branch or hook rejection carries
    /// `[rejected]` too, and telling that user to pull would send them nowhere.
    #[test]
    fn a_rejection_for_another_reason_is_passed_through() {
        let stderr = " ! [remote rejected] feat/x -> feat/x (pre-receive hook declined)";
        assert_eq!(
            classify_git_failure(stderr),
            "! [remote rejected] feat/x -> feat/x (pre-receive hook declined)"
        );
    }

    #[test]
    fn a_refused_fast_forward_says_to_resolve_it_by_hand() {
        let stderr = "fatal: Not possible to fast-forward, aborting.";
        let message = classify_git_failure(stderr);
        assert!(message.contains("no fast-forward"));
        assert!(message.contains("terminal"));
    }

    #[test]
    fn a_missing_upstream_says_to_publish() {
        let stderr = "fatal: no upstream configured for branch 'feat/x'";
        assert!(classify_git_failure(stderr).contains("Publish it first"));
    }

    /// Credential and connectivity failures are git's to explain: it names the host, the protocol
    /// and the status code, and anything we substituted would be vaguer.
    #[test]
    fn everything_else_reaches_the_user_verbatim() {
        let stderr = "remote: Permission to me/repo.git denied to nobody.\n\
                      fatal: unable to access 'https://github.com/me/repo.git/': 403";
        assert_eq!(classify_git_failure(stderr), stderr.trim());

        let offline = "fatal: unable to access 'https://github.com/me/repo.git/': \
                       Could not resolve host: github.com";
        assert_eq!(classify_git_failure(offline), offline.trim());
    }
}
