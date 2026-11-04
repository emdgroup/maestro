//! Sealing: the files a loop's sealed patterns hide from its worker.

use std::path::Path;

use crate::helpers::send_diag;
use crate::worktree::git;

/// The sealed patterns as one gitignore, each anchored at the root unless it starts with `**/`.
pub(crate) fn sealed_matcher(dir: &str, sealed: &[String]) -> ignore::gitignore::Gitignore {
    let mut builder = ignore::gitignore::GitignoreBuilder::new(dir);
    for pattern in sealed {
        let (bang, body) = match pattern.strip_prefix('!') {
            Some(body) => ("!", body),
            None => ("", pattern.as_str()),
        };
        let anchor = if body.starts_with("**/") { "" } else { "/" };
        if let Err(e) = builder.add_line(None, &format!("{bang}{anchor}{body}")) {
            send_diag("warn", format!("[loop] bad sealed pattern {pattern}: {e}"));
        }
    }
    builder
        .build()
        .unwrap_or_else(|_| ignore::gitignore::Gitignore::empty())
}

/// Remove every file the sealed patterns match: the ones the sparse checkout leaves out, and any
/// the worker made there.
pub(super) async fn remove_sealed(dir: &str, sealed: &[String]) {
    if sealed.is_empty() {
        return;
    }
    let listed = git(
        dir,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )
    .await;
    let listed = match listed {
        Ok(listed) => listed,
        Err(e) => {
            send_diag("warn", format!("[loop] cannot list {dir}: {e}"));
            return;
        }
    };
    let matcher = sealed_matcher(dir, sealed);
    let matched = listed
        .split('\0')
        .filter(|p| !p.is_empty())
        .filter(|p| matcher.matched_path_or_any_parents(p, false).is_ignore());
    for relative in matched {
        let target = Path::new(dir).join(relative);
        // Not followed: a link the worker made is removed, never what it points at.
        let Ok(meta) = tokio::fs::symlink_metadata(&target).await else {
            continue;
        };
        let removed = if meta.is_dir() {
            // A nested repository git lists as one path.
            tokio::fs::remove_dir_all(&target).await
        } else {
            tokio::fs::remove_file(&target).await
        };
        if let Err(e) = removed {
            send_diag(
                "warn",
                format!("[loop] cannot remove {}: {e}", target.display()),
            );
        }
        // The folders it leaves empty go too; one still holding anything refuses.
        let mut parent = target.parent();
        while let Some(folder) = parent.filter(|p| *p != Path::new(dir)) {
            if tokio::fs::remove_dir(folder).await.is_err() {
                break;
            }
            parent = folder.parent();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git_in(dir: &str, args: &[&str]) {
        git(dir, args).await.expect("git");
    }

    #[test]
    fn sealed_patterns_hide_and_show_as_the_table_says() {
        let sealed: Vec<String> = ["tests/", "**/*.test.ts", "docs/*.md", "!tests/helpers/"]
            .map(String::from)
            .to_vec();
        assert_eq!(
            crate::worktree::sparse_lines(&sealed),
            [
                "/*",
                "!/tests/",
                "!**/*.test.ts",
                "!/docs/*.md",
                "/tests/helpers/"
            ]
        );
        let matcher = sealed_matcher("/repo", &sealed);
        for (path, hidden) in [
            ("tests/a.ts", true),
            ("tests/deep/b.ts", true),
            ("tests/helpers/h.ts", false),
            ("src/x.test.ts", true),
            ("x.test.ts", true),
            ("src/x.ts", false),
            ("docs/a.md", true),
            ("docs/deep/a.md", false),
            ("src/tests/a.ts", false),
        ] {
            let matched = matcher.matched_path_or_any_parents(path, false).is_ignore();
            assert_eq!(matched, hidden, "{path}");
        }
    }

    #[tokio::test]
    async fn removing_the_sealed_files_takes_only_what_the_patterns_hide() {
        let repo = tempfile::tempdir().expect("tempdir");
        let dir = repo.path().to_str().unwrap();
        git_in(dir, &["init", "-q", "-b", "main"]).await;
        for file in [
            "tests/a.ts",
            "tests/helpers/h.ts",
            "src/x.test.ts",
            "src/x.ts",
        ] {
            let path = repo.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
        git_in(dir, &["add", "tests/a.ts", "src"]).await;
        let sealed: Vec<String> = ["tests/", "**/*.test.ts", "!tests/helpers/"]
            .map(String::from)
            .to_vec();
        remove_sealed(dir, &sealed).await;
        let exists = |f: &str| repo.path().join(f).exists();
        assert!(!exists("tests/a.ts") && !exists("src/x.test.ts"));
        assert!(exists("tests/helpers/h.ts") && exists("src/x.ts"));
    }
}
