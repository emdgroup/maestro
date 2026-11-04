//! An iteration's work as one commit in the loop's sandbox.

use std::time::Duration;

use super::duration_words;
use crate::task_store::loops::Committed;
use crate::worktree::git;

/// Everything the sandbox holds past `base` as one commit, the repository's hooks included. A
/// worker that committed its own work has it folded in, so an iteration stays one commit, which
/// Start over rewinds past. `None` when there was nothing to commit; the error is git's output, a
/// failing hook's included, with the worker's own commits put back.
pub(super) async fn commit(
    dir: &str,
    base: &str,
    message: &str,
    limit: Duration,
) -> Result<Option<Committed>, String> {
    let head = git(dir, &["rev-parse", "HEAD"]).await?;
    let start = git(dir, &["merge-base", base, head.trim()]).await?;
    git(dir, &["reset", "-q", "--soft", start.trim()]).await?;
    git(dir, &["add", "-A"]).await?;
    if git(dir, &["diff", "--cached", "--name-only"])
        .await?
        .trim()
        .is_empty()
    {
        return Ok(None);
    }
    let committed = commit_staged(dir, message, limit).await;
    if committed.is_err() {
        let _ = git(dir, &["reset", "-q", "--soft", head.trim()]).await;
    }
    committed?;
    let sha = git(dir, &["rev-parse", "HEAD"]).await?.trim().to_string();
    let stats = git(dir, &["show", "--numstat", "--format=", "HEAD"]).await?;
    Ok(Some(Committed {
        commit_sha: Some(sha),
        ..numstat(&stats)
    }))
}

async fn commit_staged(dir: &str, message: &str, limit: Duration) -> Result<(), String> {
    let mut command = crate::worktree::git_command(dir, &["commit", "-m", message]);
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null());
    let output = tokio::time::timeout(limit, command.output())
        .await
        .map_err(|_| {
            format!(
                "git commit timed out after {}",
                duration_words(limit.as_secs() as u32)
            )
        })?
        .map_err(|e| format!("cannot run git commit: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .trim()
        .to_string());
    }
    Ok(())
}

/// Files, lines added and lines removed. A binary file counts as a file with no lines.
fn numstat(output: &str) -> Committed {
    let mut committed = Committed::default();
    for line in output.lines().filter(|l| !l.trim().is_empty()) {
        let mut columns = line.split('\t');
        let mut count = || {
            columns
                .next()
                .and_then(|c| c.parse::<i32>().ok())
                .unwrap_or(0)
        };
        committed.added += count();
        committed.removed += count();
        committed.files += 1;
    }
    committed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_adds_up_and_binary_files_count() {
        let stats = numstat("3\t1\tsrc/a.rs\n-\t-\timg.png\n10\t0\tsrc/b.rs\n");
        assert_eq!((stats.files, stats.added, stats.removed), (3, 13, 1));
    }
}
