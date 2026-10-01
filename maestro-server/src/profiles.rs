//! Agent profiles, read by the daemon so a task's stage can be started with no window open.
//!
//! A port of `src-tauri/src/project/profiles.rs` and of the stage settings `useExecuteTask` picks,
//! reading `.maestro/profiles.json` and `.maestro/settings.json` with `std::fs`, because the daemon
//! runs on the machine the project is on. The rules are the app's; see its module for why each
//! one is what it is.
#![allow(dead_code)] // wired by task_runner in phase 5 D8

use std::collections::HashMap;
use std::path::Path;

use maestro_protocol::{AgentRole, Task};
use serde::de::DeserializeOwned;
use serde::Deserialize;

/// Modes in which a role that must not write does not write unattended. Must stay in step with
/// `READ_ONLY_MODES` plus `DEFAULT_MODE` below, as in the app.
const READ_ONLY_SAFE_MODES: [&str; 3] = ["readonly", "plan", "default"];

/// Preference lists for a profile that names no mode, first one the agent offers wins.
const WRITABLE_MODES: [&str; 5] = ["auto", "agent", "build", "full-access", "bypassPermissions"];
const READ_ONLY_MODES: [&str; 2] = ["readonly", "plan"];
const DEFAULT_MODE: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
pub enum FallbackBehaviour {
    #[default]
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub role: AgentRole,
    pub agent_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    #[serde(default)]
    pub role_prompt: Option<String>,
    #[serde(default)]
    pub fallback_behaviour: FallbackBehaviour,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProfilesDocument {
    #[serde(default)]
    pub profiles: Vec<AgentProfile>,
    /// Role → profile id. A role with no entry falls back to the first profile declaring it.
    #[serde(default)]
    pub defaults: HashMap<String, String>,
}

impl ProfilesDocument {
    /// Override → project default → the first profile declaring the role.
    pub fn resolve(&self, role: AgentRole, override_id: Option<&str>) -> Option<&AgentProfile> {
        if let Some(profile) = override_id.and_then(|id| self.profiles.iter().find(|p| p.id == id))
        {
            return Some(profile);
        }
        if let Some(id) = self.defaults.get(role_key(role)) {
            if let Some(profile) = self.profiles.iter().find(|p| &p.id == id) {
                return Some(profile);
            }
        }
        self.profiles.iter().find(|p| p.role == role)
    }
}

/// The subset of `.maestro/settings.json` a stage needs.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct ProjectSettings {
    default_agent: Option<String>,
}

fn role_key(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Refiner => "Refiner",
        AgentRole::Planner => "Planner",
        AgentRole::Coder => "Coder",
        AgentRole::Reviewer => "Reviewer",
    }
}

/// Only the coder writes.
pub fn is_read_only(role: AgentRole) -> bool {
    role != AgentRole::Coder
}

/// A missing or unreadable file is the default document, as `read_maestro_json` treats it.
fn read_maestro_json<T: DeserializeOwned + Default>(project_path: &str, file: &str) -> T {
    std::fs::read_to_string(Path::new(project_path).join(".maestro").join(file))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn read_profiles(project_path: &str) -> ProfilesDocument {
    read_maestro_json(project_path, "profiles.json")
}

pub fn default_agent(project_path: &str) -> Option<String> {
    read_maestro_json::<ProjectSettings>(project_path, "settings.json").default_agent
}

/// Whether the project defines a profile for `role`, which is how a project opts into it.
pub fn has_profile_for_role(project_path: &str, role: AgentRole) -> bool {
    read_profiles(project_path).resolve(role, None).is_some()
}

fn overrides(overrides_json: Option<&str>) -> Option<HashMap<String, Option<String>>> {
    serde_json::from_str(overrides_json?).ok()
}

/// Whether the task turned this role off: a present key with a null value. Unreadable JSON is
/// `false`, since a parse failure is not a reason to skip a stage.
pub fn role_is_skipped(overrides_json: Option<&str>, role: AgentRole) -> bool {
    overrides(overrides_json).is_some_and(|map| matches!(map.get(role_key(role)), Some(None)))
}

/// The profile id the task names for `role`, if any (`profileIdFor`).
fn profile_id_for(task: &Task, role: AgentRole) -> Option<String> {
    overrides(task.profile_overrides.as_deref())?
        .remove(role_key(role))
        .flatten()
}

/// What the agent offers, as reported at spawn. Empty lists mean "unknown", not "nothing".
#[derive(Debug, Clone, Default)]
pub struct AgentCapabilities {
    pub model_ids: Vec<String>,
    pub mode_ids: Vec<String>,
    pub supports_effort: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProfile {
    pub profile_id: String,
    pub agent_id: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub role_prompt: Option<String>,
    pub warnings: Vec<String>,
}

/// Reduce a profile to what this agent can do. `Err` only when the profile asked to fail rather
/// than degrade.
pub fn apply_capabilities(
    profile: &AgentProfile,
    capabilities: &AgentCapabilities,
) -> Result<ResolvedProfile, String> {
    let mut warnings = Vec::new();

    let model = match &profile.model {
        Some(model)
            if !capabilities.model_ids.is_empty() && !capabilities.model_ids.contains(model) =>
        {
            warnings.push(format!(
                "'{}' does not offer the model '{}', using its default",
                profile.agent_id, model
            ));
            None
        }
        other => other.clone(),
    };

    let effort = match &profile.effort {
        Some(effort) if !capabilities.supports_effort => {
            warnings.push(format!(
                "'{}' does not expose an effort setting, so '{}' is ignored",
                profile.agent_id, effort
            ));
            None
        }
        other => other.clone(),
    };

    let permission_mode = match &profile.permission_mode {
        Some(mode)
            if !capabilities.mode_ids.is_empty() && !capabilities.mode_ids.contains(mode) =>
        {
            warnings.push(format!(
                "'{}' has no '{}' permission mode, using its default",
                profile.agent_id, mode
            ));
            None
        }
        other => other.clone(),
    };

    let held_read_only = match permission_mode.as_deref() {
        Some(mode) => READ_ONLY_SAFE_MODES.contains(&mode),
        None => {
            capabilities.mode_ids.is_empty()
                || capabilities
                    .mode_ids
                    .iter()
                    .any(|mode| READ_ONLY_SAFE_MODES.contains(&mode.as_str()))
        }
    };

    if is_read_only(profile.role) && !held_read_only {
        warnings.push(format!(
            "'{}' could not be held read-only for the {:?} role",
            profile.agent_id, profile.role
        ));
    }

    if profile.fallback_behaviour == FallbackBehaviour::Fail && !warnings.is_empty() {
        return Err(format!(
            "Profile '{}' cannot run on '{}': {}",
            profile.name,
            profile.agent_id,
            warnings.join("; ")
        ));
    }

    Ok(ResolvedProfile {
        profile_id: profile.id.clone(),
        agent_id: profile.agent_id.clone(),
        model,
        effort,
        permission_mode,
        skills: profile.skills.clone(),
        mcp_servers: profile.mcp_servers.clone(),
        role_prompt: profile.role_prompt.clone(),
        warnings,
    })
}

/// The mode a profile that names none runs in (`resolveAutomaticMode`). Falls back to `default`;
/// never hands a read-only role a writable mode. `None` when nothing fits.
pub fn resolve_automatic_mode(mode_ids: &[String], read_only: bool) -> Option<String> {
    let priorities: &[&str] = if read_only {
        &READ_ONLY_MODES
    } else {
        &WRITABLE_MODES
    };
    priorities
        .iter()
        .find(|mode| mode_ids.iter().any(|id| id == *mode))
        .or_else(|| (mode_ids.iter().any(|id| id == DEFAULT_MODE)).then_some(&DEFAULT_MODE))
        .map(|mode| mode.to_string())
}

/// The agent to spawn for a stage, asked before capabilities are known. The task's own agent is
/// the coder's only; then the role's profile; then the project's default agent.
fn choose_agent(
    document: &ProfilesDocument,
    default_agent: Option<String>,
    task: &Task,
    role: AgentRole,
) -> Option<String> {
    let task_agent = (role == AgentRole::Coder)
        .then(|| task.agent_id.clone())
        .flatten();
    task_agent
        .or_else(|| {
            document
                .resolve(role, profile_id_for(task, role).as_deref())
                .map(|p| p.agent_id.clone())
        })
        .or(default_agent)
}

pub fn agent_for(project_path: &str, task: &Task, role: AgentRole) -> Option<String> {
    choose_agent(
        &read_profiles(project_path),
        default_agent(project_path),
        task,
        role,
    )
}

/// What a stage's session is set to once its agent has reported what it supports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageSettings {
    pub agent_id: Option<String>,
    pub profile_id: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    /// The value for the agent's effort config option; only set when it has one.
    pub effort: Option<String>,
    pub role_prompt: Option<String>,
    pub read_only: bool,
    pub warnings: Vec<String>,
}

fn stage_settings(
    document: &ProfilesDocument,
    default_agent: Option<String>,
    task: &Task,
    role: AgentRole,
    capabilities: &AgentCapabilities,
) -> Result<StageSettings, String> {
    let read_only = is_read_only(role);
    let agent_id = choose_agent(document, default_agent, task, role);
    let resolved = document
        .resolve(role, profile_id_for(task, role).as_deref())
        .map(|profile| apply_capabilities(profile, capabilities))
        .transpose()?;
    let mut warnings = resolved
        .as_ref()
        .map(|r| r.warnings.clone())
        .unwrap_or_default();

    // Task overrides are the coder's alone, like the agent.
    let coder = role == AgentRole::Coder;
    let model = coder
        .then(|| task.model_override.clone())
        .flatten()
        .or_else(|| resolved.as_ref().and_then(|r| r.model.clone()));
    let mut permission_mode = coder
        .then(|| task.permission_mode_override.clone())
        .flatten()
        .or_else(|| resolved.as_ref().and_then(|r| r.permission_mode.clone()));
    if permission_mode.is_none() && !capabilities.mode_ids.is_empty() {
        permission_mode = resolve_automatic_mode(&capabilities.mode_ids, read_only);
        if permission_mode.is_none() && read_only {
            warnings.push(format!(
                "{} offers no read-only mode, so it is asked not to write instead",
                agent_id.as_deref().unwrap_or("The agent")
            ));
        }
    }

    Ok(StageSettings {
        agent_id,
        profile_id: resolved.as_ref().map(|r| r.profile_id.clone()),
        model,
        permission_mode,
        effort: resolved.as_ref().and_then(|r| r.effort.clone()),
        role_prompt: resolved.and_then(|r| r.role_prompt),
        read_only,
        warnings,
    })
}

/// Settings for a stage whose agent has spawned and reported `capabilities`. `Err` when a profile
/// set to fail cannot be honoured.
pub fn resolve_stage(
    project_path: &str,
    task: &Task,
    role: AgentRole,
    capabilities: &AgentCapabilities,
) -> Result<StageSettings, String> {
    stage_settings(
        &read_profiles(project_path),
        default_agent(project_path),
        task,
        role,
        capabilities,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(role: AgentRole) -> AgentProfile {
        AgentProfile {
            id: format!("{:?}", role).to_lowercase(),
            name: format!("{:?}", role),
            role,
            agent_id: "claude".to_string(),
            model: None,
            effort: None,
            permission_mode: Some("readonly".to_string()),
            skills: vec![],
            mcp_servers: vec![],
            role_prompt: None,
            fallback_behaviour: FallbackBehaviour::Warn,
        }
    }

    fn capable() -> AgentCapabilities {
        AgentCapabilities {
            model_ids: vec!["sonnet".to_string(), "opus".to_string()],
            mode_ids: vec!["readonly".to_string(), "acceptEdits".to_string()],
            supports_effort: true,
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn task() -> Task {
        serde_json::from_value(serde_json::json!({
            "id": 1, "project_path": "/p", "title": "t", "status": "Queue",
            "priority": "Medium", "base_branch": "main", "skills": [], "labels": [],
            "created_at": "", "updated_at": "", "auto_approve": false,
            "workspace_mode": "NewWorktree", "workspace_branch_mode": "Create",
            "ball": "Agent", "review_rounds": 0, "fix_rounds": 0,
        }))
        .unwrap()
    }

    #[test]
    fn resolution_prefers_an_override_then_the_default_then_the_role() {
        let mut only = profile(AgentRole::Reviewer);
        only.id = "strict".to_string();
        let mut lenient = profile(AgentRole::Reviewer);
        lenient.id = "lenient".to_string();

        let mut doc = ProfilesDocument {
            profiles: vec![only, lenient],
            defaults: Default::default(),
        };
        assert_eq!(doc.resolve(AgentRole::Reviewer, None).unwrap().id, "strict");

        doc.defaults
            .insert("Reviewer".to_string(), "lenient".to_string());
        assert_eq!(
            doc.resolve(AgentRole::Reviewer, None).unwrap().id,
            "lenient"
        );
        assert_eq!(
            doc.resolve(AgentRole::Reviewer, Some("strict")).unwrap().id,
            "strict"
        );
    }

    #[test]
    fn an_unknown_override_falls_through_rather_than_failing() {
        let doc = ProfilesDocument {
            profiles: vec![profile(AgentRole::Coder)],
            defaults: Default::default(),
        };
        assert_eq!(
            doc.resolve(AgentRole::Coder, Some("deleted")).unwrap().id,
            "coder"
        );
    }

    #[test]
    fn a_role_with_no_profile_resolves_to_nothing() {
        let doc = ProfilesDocument {
            profiles: vec![profile(AgentRole::Coder)],
            defaults: Default::default(),
        };
        assert!(doc.resolve(AgentRole::Reviewer, None).is_none());
    }

    #[test]
    fn only_a_present_null_marks_a_role_as_skipped() {
        let json = r#"{"Planner": null, "Reviewer": "strict"}"#;
        assert!(role_is_skipped(Some(json), AgentRole::Planner));
        assert!(!role_is_skipped(Some(json), AgentRole::Reviewer));
        assert!(!role_is_skipped(Some(json), AgentRole::Refiner));
        assert!(!role_is_skipped(None, AgentRole::Planner));
        assert!(!role_is_skipped(Some("{"), AgentRole::Planner));
        assert!(!role_is_skipped(Some("[]"), AgentRole::Planner));
    }

    #[test]
    fn a_fully_supported_profile_resolves_without_warnings() {
        let mut p = profile(AgentRole::Reviewer);
        p.model = Some("opus".to_string());
        p.effort = Some("high".to_string());
        let resolved = apply_capabilities(&p, &capable()).unwrap();
        assert!(resolved.warnings.is_empty(), "{:?}", resolved.warnings);
        assert_eq!(resolved.model.as_deref(), Some("opus"));
        assert_eq!(resolved.permission_mode.as_deref(), Some("readonly"));
    }

    #[test]
    fn unsupported_fields_are_dropped_with_a_warning() {
        let mut p = profile(AgentRole::Coder);
        p.model = Some("gpt-9".to_string());
        p.effort = Some("high".to_string());
        p.permission_mode = Some("acceptEdits".to_string());
        let capabilities = AgentCapabilities {
            model_ids: strings(&["sonnet"]),
            mode_ids: strings(&["acceptEdits"]),
            supports_effort: false,
        };
        let resolved = apply_capabilities(&p, &capabilities).unwrap();
        assert_eq!(resolved.model, None);
        assert_eq!(resolved.effort, None);
        assert_eq!(resolved.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(resolved.warnings.len(), 2, "{:?}", resolved.warnings);
    }

    #[test]
    fn unknown_capabilities_are_not_treated_as_missing_ones() {
        let p = profile(AgentRole::Reviewer);
        let resolved = apply_capabilities(&p, &AgentCapabilities::default()).unwrap();
        assert_eq!(resolved.permission_mode.as_deref(), Some("readonly"));
        assert!(resolved.warnings.is_empty(), "{:?}", resolved.warnings);
    }

    #[test]
    fn a_read_only_role_that_cannot_be_held_read_only_is_reported() {
        let mut p = profile(AgentRole::Reviewer);
        let capabilities = AgentCapabilities {
            mode_ids: strings(&["acceptEdits"]),
            ..Default::default()
        };
        let warned = apply_capabilities(&p, &capabilities).unwrap();
        assert_eq!(warned.permission_mode, None);
        assert_eq!(warned.warnings.len(), 2, "{:?}", warned.warnings);

        p.fallback_behaviour = FallbackBehaviour::Fail;
        assert!(apply_capabilities(&p, &capabilities).is_err());
    }

    #[test]
    fn a_writable_mode_does_not_count_as_holding_a_read_only_role() {
        let mut p = profile(AgentRole::Planner);
        p.permission_mode = Some("acceptEdits".to_string());
        let resolved = apply_capabilities(&p, &capable()).unwrap();
        assert_eq!(resolved.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(resolved.warnings.len(), 1, "{:?}", resolved.warnings);
    }

    #[test]
    fn default_holds_a_read_only_role_without_a_warning() {
        let mut p = profile(AgentRole::Refiner);
        p.permission_mode = Some("default".to_string());
        let capabilities = AgentCapabilities {
            mode_ids: strings(&["default", "acceptEdits"]),
            ..Default::default()
        };
        let resolved = apply_capabilities(&p, &capabilities).unwrap();
        assert!(resolved.warnings.is_empty(), "{:?}", resolved.warnings);
    }

    #[test]
    fn an_unnamed_mode_is_held_by_whatever_the_agent_offers() {
        let mut p = profile(AgentRole::Refiner);
        p.permission_mode = None;
        let capabilities = AgentCapabilities {
            mode_ids: strings(&["default", "acceptEdits", "bypassPermissions", "plan"]),
            ..Default::default()
        };
        let resolved = apply_capabilities(&p, &capabilities).unwrap();
        assert!(resolved.warnings.is_empty(), "{:?}", resolved.warnings);
    }

    #[test]
    fn an_unnamed_mode_still_warns_when_nothing_safe_is_offered() {
        let mut p = profile(AgentRole::Refiner);
        p.permission_mode = None;
        let capabilities = AgentCapabilities {
            mode_ids: strings(&["acceptEdits", "bypassPermissions"]),
            ..Default::default()
        };
        let resolved = apply_capabilities(&p, &capabilities).unwrap();
        assert_eq!(resolved.warnings.len(), 1, "{:?}", resolved.warnings);

        p.fallback_behaviour = FallbackBehaviour::Fail;
        assert!(apply_capabilities(&p, &capabilities).is_err());
    }

    #[test]
    fn the_coder_is_not_forced_read_only() {
        let mut p = profile(AgentRole::Coder);
        p.permission_mode = None;
        let resolved = apply_capabilities(&p, &capable()).unwrap();
        assert!(resolved.warnings.is_empty(), "{:?}", resolved.warnings);
    }

    // Ported from permission-modes.test.ts.

    #[test]
    fn automatic_mode_prefers_the_strongest_writable_mode() {
        assert_eq!(
            resolve_automatic_mode(&strings(&["bypassPermissions", "auto", "default"]), false)
                .as_deref(),
            Some("auto")
        );
    }

    #[test]
    fn automatic_mode_prefers_the_strongest_read_only_mode() {
        assert_eq!(
            resolve_automatic_mode(&strings(&["default", "auto", "plan", "readonly"]), true)
                .as_deref(),
            Some("readonly")
        );
    }

    #[test]
    fn automatic_mode_falls_back_to_default_for_either_role() {
        let modes = strings(&["default", "acceptEdits"]);
        assert_eq!(
            resolve_automatic_mode(&modes, false).as_deref(),
            Some("default")
        );
        assert_eq!(
            resolve_automatic_mode(&modes, true).as_deref(),
            Some("default")
        );
    }

    #[test]
    fn automatic_mode_refuses_a_writable_mode_for_a_read_only_role() {
        assert_eq!(
            resolve_automatic_mode(&strings(&["auto", "bypassPermissions"]), true),
            None
        );
    }

    #[test]
    fn automatic_mode_has_no_answer_when_the_agent_offers_nothing() {
        assert_eq!(resolve_automatic_mode(&[], false), None);
        assert_eq!(resolve_automatic_mode(&[], true), None);
    }

    #[test]
    fn only_the_coder_writes() {
        assert!(!is_read_only(AgentRole::Coder));
        assert!(is_read_only(AgentRole::Refiner));
        assert!(is_read_only(AgentRole::Planner));
        assert!(is_read_only(AgentRole::Reviewer));
    }

    // The agent choice order from useExecuteTask.

    fn two_profiles() -> ProfilesDocument {
        let mut coder = profile(AgentRole::Coder);
        coder.agent_id = "profile-coder".to_string();
        let mut reviewer = profile(AgentRole::Reviewer);
        reviewer.agent_id = "profile-reviewer".to_string();
        let mut other = profile(AgentRole::Reviewer);
        other.id = "other".to_string();
        other.agent_id = "other-reviewer".to_string();
        ProfilesDocument {
            profiles: vec![coder, reviewer, other],
            defaults: Default::default(),
        }
    }

    #[test]
    fn the_coder_uses_the_tasks_agent_first() {
        let mut t = task();
        t.agent_id = Some("task-agent".to_string());
        let doc = two_profiles();
        let pick = |role| choose_agent(&doc, Some("default".to_string()), &t, role);
        assert_eq!(pick(AgentRole::Coder).as_deref(), Some("task-agent"));
        // The task's agent is not imposed on the other roles.
        assert_eq!(
            pick(AgentRole::Reviewer).as_deref(),
            Some("profile-reviewer")
        );
        assert_eq!(pick(AgentRole::Planner).as_deref(), Some("default"));
    }

    #[test]
    fn a_profile_beats_the_default_and_a_task_override_picks_the_profile() {
        let mut t = task();
        let doc = two_profiles();
        assert_eq!(
            choose_agent(&doc, Some("default".to_string()), &t, AgentRole::Coder).as_deref(),
            Some("profile-coder")
        );
        t.profile_overrides = Some(r#"{"Reviewer": "other"}"#.to_string());
        assert_eq!(
            choose_agent(&doc, None, &t, AgentRole::Reviewer).as_deref(),
            Some("other-reviewer")
        );
        assert_eq!(
            choose_agent(&ProfilesDocument::default(), None, &t, AgentRole::Coder),
            None
        );
    }

    #[test]
    fn task_overrides_apply_to_the_coder_only() {
        let mut t = task();
        t.model_override = Some("task-model".to_string());
        t.permission_mode_override = Some("acceptEdits".to_string());
        let mut doc = two_profiles();
        doc.profiles[1].model = Some("opus".to_string());

        let coder = stage_settings(&doc, None, &t, AgentRole::Coder, &capable()).unwrap();
        assert_eq!(coder.model.as_deref(), Some("task-model"));
        assert_eq!(coder.permission_mode.as_deref(), Some("acceptEdits"));
        assert!(!coder.read_only);

        let reviewer = stage_settings(&doc, None, &t, AgentRole::Reviewer, &capable()).unwrap();
        assert_eq!(reviewer.model.as_deref(), Some("opus"));
        assert_eq!(reviewer.permission_mode.as_deref(), Some("readonly"));
        assert_eq!(reviewer.profile_id.as_deref(), Some("reviewer"));
        assert!(reviewer.read_only);
    }

    #[test]
    fn with_no_profile_mode_the_automatic_mode_is_picked() {
        let t = task();
        let capabilities = AgentCapabilities {
            mode_ids: strings(&["default", "plan", "auto"]),
            ..Default::default()
        };
        let doc = ProfilesDocument::default();
        let planner = stage_settings(
            &doc,
            Some("a".to_string()),
            &t,
            AgentRole::Planner,
            &capabilities,
        )
        .unwrap();
        assert_eq!(planner.permission_mode.as_deref(), Some("plan"));
        let coder = stage_settings(&doc, None, &t, AgentRole::Coder, &capabilities).unwrap();
        assert_eq!(coder.permission_mode.as_deref(), Some("auto"));

        let writable = AgentCapabilities {
            mode_ids: strings(&["auto"]),
            ..Default::default()
        };
        let refiner = stage_settings(
            &doc,
            Some("a".to_string()),
            &t,
            AgentRole::Refiner,
            &writable,
        )
        .unwrap();
        assert_eq!(refiner.permission_mode, None);
        assert_eq!(refiner.warnings.len(), 1);
    }

    #[test]
    fn files_are_read_from_the_projects_maestro_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert!(!has_profile_for_role(path, AgentRole::Reviewer));
        assert_eq!(default_agent(path), None);

        std::fs::create_dir(dir.path().join(".maestro")).unwrap();
        std::fs::write(
            dir.path().join(".maestro/profiles.json"),
            r#"{"profiles":[{"id":"r","name":"R","role":"Reviewer","agent_id":"codex"}]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join(".maestro/settings.json"),
            r#"{"default_agent":"claude","updated_at":"x"}"#,
        )
        .unwrap();
        assert!(has_profile_for_role(path, AgentRole::Reviewer));
        assert_eq!(default_agent(path).as_deref(), Some("claude"));
        assert_eq!(
            agent_for(path, &task(), AgentRole::Reviewer).as_deref(),
            Some("codex")
        );
        assert_eq!(
            agent_for(path, &task(), AgentRole::Coder).as_deref(),
            Some("claude")
        );
    }
}
