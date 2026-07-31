//! Installs Maestro's own agent skills onto the machine this server runs on.
//!
//! The files arrive in the request rather than being vendored here, because on local connections
//! this binary is a downloaded release artifact — a skill baked in would only reach users on the
//! next server release instead of the next app release.

use std::path::{Component, Path, PathBuf};

use maestro_protocol::SkillFile;

use crate::command_ext::NoConsoleWindow;

/// Pinned deliberately. `@latest` would fetch and execute whatever npm serves at that moment on
/// every machine Maestro touches, which is the supply-chain exposure `AGENTS.md` rejects for the
/// bundled agent registry.
const SKILLS_CLI: &str = "skills@1.5.21";

const INSTALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Stage the skills under the target's home and hand them to the skills.sh CLI.
///
/// Returns `false` when the target already had exactly these skills installed and nothing ran.
pub(crate) async fn install(skills: Vec<SkillFile>) -> Result<bool, String> {
    let home = crate::tool_config::home_dir()?;
    let stage = stage_root(&home);
    if !stage_files(&stage, &home, &skills)? {
        return Ok(false);
    }
    run_installer(&stage).await?;
    Ok(true)
}

fn stage_root(home: &Path) -> PathBuf {
    home.join(".maestro").join("skills")
}

/// Write the skill files under `stage`, returning whether an install still has to run.
///
/// A stable staging directory rather than a temporary one: the CLI records the source path in its
/// lock file, and a path that no longer exists makes that record useless.
fn stage_files(stage: &Path, home: &Path, skills: &[SkillFile]) -> Result<bool, String> {
    let resolved = skills
        .iter()
        .map(|skill| Ok((safe_join(stage, &skill.path)?, skill)))
        .collect::<Result<Vec<_>, String>>()?;

    let current = resolved.iter().all(|(target, skill)| {
        std::fs::read_to_string(target).is_ok_and(|contents| contents == skill.contents)
    });
    if current && skills.iter().all(|skill| is_installed(home, &skill.path)) {
        return Ok(false);
    }

    for (target, skill) in &resolved {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        std::fs::write(target, &skill.contents)
            .map_err(|error| format!("Failed to write {}: {error}", target.display()))?;
    }
    Ok(true)
}

/// Join a request-supplied relative path onto `base`, refusing anything that could escape it.
fn safe_join(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if !relative
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(format!("Unsafe skill path: {}", relative.display()));
    }
    Ok(base.join(relative))
}

/// Whether the skill owning `relative_path` is already present where agents look for it.
///
/// The CLI writes the canonical copy to `~/.agents/skills/<name>` and fans out from there, so that
/// one file answers the question for every agent it installed to.
fn is_installed(home: &Path, relative_path: &str) -> bool {
    let Some(name) = Path::new(relative_path)
        .components()
        .next()
        .and_then(|component| match component {
            Component::Normal(name) => Some(name),
            _ => None,
        })
    else {
        return false;
    };
    home.join(".agents")
        .join("skills")
        .join(name)
        .join("SKILL.md")
        .is_file()
}

async fn run_installer(stage: &Path) -> Result<(), String> {
    let npx = crate::tool_check::resolve_tool_path("npx").await?;
    let mut command = crate::tool_check::command_for(&npx);
    // `--all` is the CLI's shorthand for `--skill '*' --agent '*' -y`: every skill in the source,
    // every agent it knows about, no prompts. `-g` keeps this out of the user's projects.
    command
        .arg("-y")
        .arg(SKILLS_CLI)
        .arg("add")
        .arg(stage)
        .arg("-g")
        .arg("--all");
    crate::tool_check::prepend_parent_to_path(&mut command, &npx, None);

    let output = tokio::time::timeout(
        INSTALL_TIMEOUT,
        command
            .stdin(std::process::Stdio::null())
            .no_console_window()
            .output(),
    )
    .await
    .map_err(|_| format!("skills install timed out after {INSTALL_TIMEOUT:?}"))?
    .map_err(|error| format!("Failed to execute {}: {error}", npx.display()))?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim().lines().rev().take(3).collect::<Vec<_>>();
    Err(format!(
        "skills install exited with {}: {}",
        output.status,
        detail.into_iter().rev().collect::<Vec<_>>().join(" | ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(path: &str, contents: &str) -> SkillFile {
        SkillFile {
            path: path.to_string(),
            contents: contents.to_string(),
        }
    }

    /// Staging has to report "nothing to do" only when the files match *and* the CLI's output is
    /// present. Reporting it on content alone would leave a user whose `~/.agents` was wiped with
    /// no skills and no way to get them back short of editing the staged copy.
    #[test]
    fn staging_reruns_until_the_skill_is_actually_installed() {
        let home = tempfile::tempdir().expect("temp home");
        let stage = stage_root(home.path());
        let skills = vec![
            skill("maestro-output/SKILL.md", "body"),
            skill("maestro-output/references/canvas.md", "canvas"),
        ];

        assert!(stage_files(&stage, home.path(), &skills).expect("first stage"));
        assert!(
            stage_files(&stage, home.path(), &skills).expect("second stage"),
            "not installed yet, so it must still run"
        );

        let installed = home.path().join(".agents").join("skills").join("maestro-output");
        std::fs::create_dir_all(&installed).expect("installed dir");
        std::fs::write(installed.join("SKILL.md"), "body").expect("installed file");

        assert!(!stage_files(&stage, home.path(), &skills).expect("third stage"));

        let changed = vec![skill("maestro-output/SKILL.md", "new body")];
        assert!(stage_files(&stage, home.path(), &changed).expect("changed stage"));
        assert_eq!(
            std::fs::read_to_string(stage.join("maestro-output/SKILL.md")).expect("read staged"),
            "new body"
        );
    }

    #[test]
    fn staging_refuses_paths_that_escape_the_stage() {
        let home = tempfile::tempdir().expect("temp home");
        let stage = stage_root(home.path());

        for path in ["../evil.md", "a/../../evil.md", "/etc/evil.md"] {
            assert!(
                stage_files(&stage, home.path(), &[skill(path, "x")]).is_err(),
                "{path} must be rejected"
            );
        }
    }
}
