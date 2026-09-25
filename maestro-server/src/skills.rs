//! Installs agent skills onto the machine this server runs on: Maestro's own, and the ones the
//! user manages from Collections.
//!
//! The files arrive in the request rather than being vendored here, because on local connections
//! this binary is a downloaded release artifact — a skill baked in would only reach users on the
//! next server release instead of the next app release.
//!
//! A managed skill lives in `~/.maestro/skill-library/<name>/` and is handed to the skills CLI per
//! agent from there. `~/.maestro/skills.json` records which agents have it, so a skill turned off
//! for every agent is still listed and can be turned back on.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use maestro_protocol::{ApplySkillRequest, ManagedSkill, ProjectSkill, SkillFile, SkillList};
use serde::{Deserialize, Serialize};

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
    // `--all` is the CLI's shorthand for `--skill '*' --agent '*' -y`: every skill in the source,
    // every agent it knows about, no prompts. `-g` keeps this out of the user's projects.
    run_cli(vec![
        "add".into(),
        stage.into(),
        "-g".into(),
        "--all".into(),
    ])
    .await
}

async fn run_cli(args: Vec<OsString>) -> Result<(), String> {
    let npx = crate::tool_check::resolve_tool_path("npx").await?;
    let mut command = crate::tool_check::command_for(&npx);
    command.arg("-y").arg(SKILLS_CLI).args(args);
    crate::tool_check::prepend_parent_to_path(&mut command, &npx, None);

    let output = tokio::time::timeout(
        INSTALL_TIMEOUT,
        command
            .stdin(std::process::Stdio::null())
            .no_console_window()
            .output(),
    )
    .await
    .map_err(|_| format!("skills CLI timed out after {INSTALL_TIMEOUT:?}"))?
    .map_err(|error| format!("Failed to execute {}: {error}", npx.display()))?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim().lines().rev().take(3).collect::<Vec<_>>();
    Err(format!(
        "skills CLI exited with {}: {}",
        output.status,
        detail.into_iter().rev().collect::<Vec<_>>().join(" | ")
    ))
}

/// Maestro agent id, the skills CLI's agent key, and the directory that agent reads skills from
/// inside a project, all checked against the agent table of the pinned `SKILLS_CLI`. An agent
/// missing here cannot take a managed skill and is drawn disabled.
///
/// Several CLI agents (cline, codex, cursor, gemini-cli, github-copilot, opencode, amp and more)
/// read the shared `~/.agents/skills`, so turning a skill off for one of them can turn it off for
/// the others that read the same directory.
const AGENT_SKILL_TARGETS: &[(&str, &str, &str)] = &[
    ("amp-acp", "amp", ".agents/skills"),
    ("antigravity-acp", "antigravity", ".agents/skills"),
    ("auggie", "augment", ".augment/skills"),
    ("autohand", "autohand-code", ".autohand/skills"),
    ("claude-acp", "claude-code", ".claude/skills"),
    ("cline", "cline", ".agents/skills"),
    ("codebuddy-code", "codebuddy", ".codebuddy/skills"),
    ("codex-acp", "codex", ".agents/skills"),
    ("cortex-code", "cortex", ".cortex/skills"),
    ("cursor", "cursor", ".agents/skills"),
    ("deepagents", "deepagents", ".agents/skills"),
    ("devin", "devin", ".devin/skills"),
    ("factory-droid", "droid", ".factory/skills"),
    ("gemini", "gemini-cli", ".agents/skills"),
    ("github-copilot-cli", "github-copilot", ".agents/skills"),
    ("goose", "goose", ".goose/skills"),
    ("grok-build", "grok", ".grok/skills"),
    ("junie", "junie", ".junie/skills"),
    ("kilo", "kilo", ".kilocode/skills"),
    ("kimchi", "kimchi", ".kimchi/skills"),
    ("kimi", "kimi-code-cli", ".agents/skills"),
    ("mistral-vibe", "mistral-vibe", ".vibe/skills"),
    ("opencode", "opencode", ".agents/skills"),
    ("pi-acp", "pi", ".pi/skills"),
    ("qoder", "qoder", ".qoder/skills"),
    ("qwen-code", "qwen-code", ".qwen/skills"),
];

fn cli_agent(agent_id: &str) -> Option<&'static str> {
    AGENT_SKILL_TARGETS
        .iter()
        .find(|(id, _, _)| *id == agent_id)
        .map(|(_, cli, _)| *cli)
}

/// One managed skill change at a time: each reads and rewrites `skills.json`.
static MANAGED: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default, Serialize, Deserialize)]
struct SkillState {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    skills: BTreeMap<String, SkillEntry>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct SkillEntry {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    agents: BTreeMap<String, bool>,
}

fn library_root(home: &Path) -> PathBuf {
    home.join(".maestro").join("skill-library")
}

fn state_path(home: &Path) -> PathBuf {
    home.join(".maestro").join("skills.json")
}

fn read_state(home: &Path) -> Result<SkillState, String> {
    let path = state_path(home);
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|error| format!("Invalid {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SkillState::default()),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

fn write_state(home: &Path, mut state: SkillState) -> Result<(), String> {
    state.version = 1;
    crate::mcp_store::write_json_atomic(&state_path(home), &state)
}

/// The Agent Skills name rule, which is also what keeps a name safe to use as a directory.
fn validate_name(name: &str) -> Result<(), String> {
    let valid = (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(format!(
            "\"{name}\" is not a valid skill name: use 1 to 64 lowercase letters, digits and hyphens"
        ))
    }
}

/// The skills a project carries in its agents' own directories, each with the agents that read it.
fn project_skills(root: &Path) -> Vec<ProjectSkill> {
    let mut dirs: Vec<&str> = AGENT_SKILL_TARGETS.iter().map(|(_, _, dir)| *dir).collect();
    dirs.sort_unstable();
    dirs.dedup();
    let mut found = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
            continue;
        };
        let agents: Vec<String> = AGENT_SKILL_TARGETS
            .iter()
            .filter(|(_, _, d)| *d == dir)
            .map(|(id, _, _)| (*id).to_string())
            .collect();
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().join("SKILL.md").is_file())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for name in names {
            found.push(ProjectSkill {
                skill_md: std::fs::read_to_string(root.join(dir).join(&name).join("SKILL.md"))
                    .unwrap_or_default(),
                dir: format!("{dir}/{name}"),
                name,
                agents: agents.clone(),
            });
        }
    }
    found
}

pub(crate) fn list(project_path: Option<&str>) -> Result<SkillList, String> {
    let home = crate::tool_config::home_dir()?;
    let library = library_root(&home);
    let skills = read_state(&home)?
        .skills
        .into_iter()
        .map(|(name, entry)| ManagedSkill {
            skill_md: std::fs::read_to_string(library.join(&name).join("SKILL.md"))
                .unwrap_or_default(),
            name,
            source: entry.source,
            agents: entry.agents,
        })
        .collect();
    Ok(SkillList {
        skills,
        supported_agents: AGENT_SKILL_TARGETS
            .iter()
            .map(|(id, _, _)| (*id).to_string())
            .collect(),
        project: project_path
            .map(|path| project_skills(Path::new(path)))
            .unwrap_or_default(),
    })
}

/// Which CLI agents to install for and which to remove from, to get from `before` to `after`.
/// `rewritten` reinstalls every enabled agent, since the library copy changed under them.
fn reconcile(
    before: &BTreeMap<String, bool>,
    after: &BTreeMap<String, bool>,
    rewritten: bool,
) -> (Vec<&'static str>, Vec<&'static str>) {
    let was_on = |agent: &str| before.get(agent) == Some(&true);
    let mut add = Vec::new();
    let mut remove = Vec::new();
    for (agent, &on) in after {
        let Some(cli) = cli_agent(agent) else {
            continue;
        };
        if on && (rewritten || !was_on(agent)) {
            add.push(cli);
        } else if !on && was_on(agent) {
            remove.push(cli);
        }
    }
    for agent in before
        .keys()
        .filter(|a| !after.contains_key(*a) && was_on(a))
    {
        if let Some(cli) = cli_agent(agent) {
            remove.push(cli);
        }
    }
    (add, remove)
}

pub(crate) async fn apply(req: ApplySkillRequest) -> Result<(), String> {
    validate_name(&req.name)?;
    let _guard = MANAGED.lock().await;
    let home = crate::tool_config::home_dir()?;
    let dir = library_root(&home).join(&req.name);
    let mut state = read_state(&home)?;
    let before = state.skills.get(&req.name).cloned().unwrap_or_default();

    if let Some(files) = &req.files {
        if !files.iter().any(|f| f.path == "SKILL.md") {
            return Err("A skill needs a SKILL.md".to_string());
        }
        let resolved = files
            .iter()
            .map(|f| Ok((safe_join(&dir, &f.path)?, f)))
            .collect::<Result<Vec<_>, String>>()?;
        // Rewritten whole, so a file dropped from the skill does not linger in the library.
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .map_err(|error| format!("Failed to clear {}: {error}", dir.display()))?;
        }
        for (target, file) in resolved {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
            }
            std::fs::write(&target, &file.contents)
                .map_err(|error| format!("Failed to write {}: {error}", target.display()))?;
        }
    } else if !dir.join("SKILL.md").is_file() {
        return Err(format!("{} is not in the skill library", req.name));
    }

    let (add, remove) = reconcile(&before.agents, &req.agents, req.files.is_some());
    // Removal first: agents sharing a directory would otherwise lose what was just added.
    if !remove.is_empty() {
        run_cli(cli_args("remove", req.name.as_str().into(), &remove)).await?;
    }
    if !add.is_empty() {
        run_cli(cli_args("add", dir.into_os_string(), &add)).await?;
    }

    state.skills.insert(
        req.name,
        SkillEntry {
            source: req.source.or(before.source),
            agents: req.agents,
        },
    );
    write_state(&home, state)
}

pub(crate) async fn delete(name: &str) -> Result<(), String> {
    validate_name(name)?;
    let _guard = MANAGED.lock().await;
    let home = crate::tool_config::home_dir()?;
    let mut state = read_state(&home)?;
    if let Some(entry) = state.skills.remove(name) {
        let (_, remove) = reconcile(&entry.agents, &BTreeMap::new(), false);
        if !remove.is_empty() {
            run_cli(cli_args("remove", name.into(), &remove)).await?;
        }
    }
    let dir = library_root(&home).join(name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|error| format!("Failed to remove {}: {error}", dir.display()))?;
    }
    write_state(&home, state)
}

fn cli_args(verb: &str, target: OsString, agents: &[&str]) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![verb.into(), target, "-g".into(), "-y".into(), "-a".into()];
    args.extend(agents.iter().map(OsString::from));
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agents(pairs: &[(&str, bool)]) -> BTreeMap<String, bool> {
        pairs
            .iter()
            .map(|(a, on)| ((*a).to_string(), *on))
            .collect()
    }

    #[test]
    fn reconcile_installs_what_turned_on_and_removes_what_turned_off() {
        let before = agents(&[("claude-acp", true), ("codex-acp", true), ("goose", false)]);
        let after = agents(&[("claude-acp", true), ("codex-acp", false), ("goose", true)]);
        assert_eq!(
            reconcile(&before, &after, false),
            (vec!["goose"], vec!["codex"])
        );
    }

    #[test]
    fn reconcile_reinstalls_everything_enabled_when_the_files_changed() {
        let before = agents(&[("claude-acp", true)]);
        let after = agents(&[("claude-acp", true), ("unknown-agent", true)]);
        assert_eq!(
            reconcile(&before, &after, true),
            (vec!["claude-code"], vec![])
        );
    }

    #[test]
    fn reconcile_removes_agents_dropped_from_the_list() {
        let before = agents(&[("claude-acp", true), ("goose", false)]);
        assert_eq!(
            reconcile(&before, &BTreeMap::new(), false),
            (vec![], vec!["claude-code"])
        );
    }

    #[test]
    fn project_skills_are_found_with_the_agents_that_read_them() {
        let root = tempfile::tempdir().expect("root");
        for dir in [
            ".claude/skills/review",
            ".agents/skills/deploy",
            ".claude/skills/empty",
        ] {
            std::fs::create_dir_all(root.path().join(dir)).expect("dir");
        }
        std::fs::write(root.path().join(".claude/skills/review/SKILL.md"), "r").expect("w");
        std::fs::write(root.path().join(".agents/skills/deploy/SKILL.md"), "d").expect("w");
        let found = project_skills(root.path());
        let names: Vec<_> = found.iter().map(|s| s.dir.as_str()).collect();
        assert_eq!(
            names,
            vec![".agents/skills/deploy", ".claude/skills/review"]
        );
        assert!(found[0].agents.contains(&"codex-acp".to_string()));
        assert_eq!(found[1].agents, vec!["claude-acp"]);
    }

    #[test]
    fn skill_names_follow_the_agent_skills_rule() {
        let long = "x".repeat(65);
        for bad in ["", "PDF", "a/b", "..", "a_b", long.as_str()] {
            assert!(validate_name(bad).is_err(), "{bad} must be rejected");
        }
        assert!(validate_name("pdf-tools-2").is_ok());
    }

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

        let installed = home
            .path()
            .join(".agents")
            .join("skills")
            .join("maestro-output");
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
