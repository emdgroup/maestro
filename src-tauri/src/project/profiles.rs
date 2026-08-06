//! Agent profiles: what an agent *is* for a given role on this project.
//!
//! A role is not an agent — "review" means something different in every codebase, and the thing
//! that makes it mean anything is the prompt and the permissions it runs under. A profile bundles
//! those with the agent and model, so a project can say "the reviewer is a different model from the
//! coder, reads only, and looks for these things" once rather than per task.
//!
//! Stored in `.maestro/profiles.json` and committed, because a reviewer's instructions are a
//! property of the project rather than of the machine that happens to run it. That also puts them
//! on the remote for SSH and WSL projects, next to the code they describe.
//!
//! `permission_mode` is load-bearing rather than decorative: it is the mechanism that makes the
//! refiner, planner and reviewer read-only, which is what three separate design decisions rest on.
//! In particular it is why a user saying "go ahead" inside a plan session cannot silently become an
//! implementation — the agent physically cannot write until the board changes its mode at the gate.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::State;

use crate::core::project_storage::{read_maestro_json, write_maestro_json};
use crate::core::AppState;
use crate::models::GitConnection;

pub const PROFILES_FILE: &str = "profiles.json";

/// What a profile does when the agent it names cannot honour part of it.
///
/// Agents differ in which models and permission modes they expose, and `effort` is not universal
/// at all. Failing the spawn over an unsupported field would make a shared profile unusable for
/// anyone whose agent differs slightly, so the default is to carry on and say so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "PascalCase")]
pub enum FallbackBehaviour {
    /// Drop the unsupported field, spawn anyway, warn the user.
    #[default]
    Warn,
    /// Refuse to spawn. For a profile whose whole point is the field that is missing — a
    /// read-only reviewer on an agent with no read-only mode is not a reviewer.
    Fail,
}

/// The role a profile is written for.
///
/// Selecting by role is what lets a task say "plan with the planner" without naming a profile, and
/// what makes a project's default reviewer a project-level fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "PascalCase")]
pub enum AgentRole {
    Refiner,
    Planner,
    Coder,
    Reviewer,
}

impl AgentRole {
    /// Whether the role is allowed to modify the repository.
    ///
    /// Three of the four roles write nothing, and this is the single place that says so — a profile
    /// claiming otherwise is corrected rather than trusted, because the read-only guarantee is what
    /// the plan and proposal gates are built on.
    pub fn is_read_only(self) -> bool {
        !matches!(self, AgentRole::Coder)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub role: AgentRole,
    pub agent_id: String,
    #[specta(optional)]
    pub model: Option<String>,
    /// Not ACP-universal — agents that do not expose it drop it per `fallback_behaviour`.
    #[specta(optional)]
    pub effort: Option<String>,
    /// The ACP session mode id. `None` means "whatever the agent defaults to", which is only
    /// appropriate for the coder.
    #[specta(optional)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    /// What the role means for this project. The field that makes a profile worth having: without
    /// it every project gets a generic reviewer.
    #[specta(optional)]
    pub role_prompt: Option<String>,
    #[serde(default)]
    pub fallback_behaviour: FallbackBehaviour,
}

/// The project's profiles, plus which one each role uses by default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct ProfilesDocument {
    #[serde(default)]
    pub profiles: Vec<AgentProfile>,
    /// Role → profile id. A role with no entry falls back to the first profile declaring it.
    #[serde(default)]
    pub defaults: std::collections::HashMap<String, String>,
}

impl ProfilesDocument {
    /// The profile to use for a role, given an optional explicit override.
    ///
    /// Resolution order is override → project default → the first profile declaring the role.
    /// The last step is what keeps a project usable after someone adds a reviewer profile without
    /// also remembering to mark it as the default.
    pub fn resolve(&self, role: AgentRole, override_id: Option<&str>) -> Option<&AgentProfile> {
        if let Some(id) = override_id {
            if let Some(profile) = self.profiles.iter().find(|p| p.id == id) {
                return Some(profile);
            }
        }

        let role_key = serde_json::to_value(role).ok()?.as_str()?.to_string();
        if let Some(id) = self.defaults.get(&role_key) {
            if let Some(profile) = self.profiles.iter().find(|p| &p.id == id) {
                return Some(profile);
            }
        }

        self.profiles.iter().find(|p| p.role == role)
    }
}

/// What a profile resolved to for an actual spawn, with anything the agent cannot honour removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ResolvedProfile {
    pub profile_id: String,
    pub agent_id: String,
    #[specta(optional)]
    pub model: Option<String>,
    #[specta(optional)]
    pub effort: Option<String>,
    #[specta(optional)]
    pub permission_mode: Option<String>,
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
    #[specta(optional)]
    pub role_prompt: Option<String>,
    /// Human-readable notes about what was dropped, for the UI to show. Empty is the happy path.
    pub warnings: Vec<String>,
}

/// What the agent actually offers, as reported at spawn.
///
/// Empty lists mean "unknown", not "nothing" — an agent that reports no modes has not told us it
/// lacks the one we want, and refusing on that basis would break every agent that stays quiet.
#[derive(Debug, Clone, Default)]
pub struct AgentCapabilities {
    pub model_ids: Vec<String>,
    pub mode_ids: Vec<String>,
    pub supports_effort: bool,
}

/// Reduce a profile to what this agent can actually do.
///
/// Returns `Err` only when the profile asked to fail rather than degrade. The read-only correction
/// is not a degradation and is applied regardless: a profile for a read-only role that names a
/// writable mode is a mistake, and honouring it would quietly hand a planner the ability to
/// implement its own plan.
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
                "'{}' does not offer the model '{}' — using its default",
                profile.agent_id, model
            ));
            None
        }
        other => other.clone(),
    };

    let effort = match &profile.effort {
        Some(effort) if !capabilities.supports_effort => {
            warnings.push(format!(
                "'{}' does not expose an effort setting — '{}' ignored",
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
                "'{}' has no '{}' permission mode — using its default",
                profile.agent_id, mode
            ));
            None
        }
        other => other.clone(),
    };

    // A read-only role that ended up with no mode is the case `Fail` exists for: the guarantee the
    // gates depend on cannot be provided, and spawning anyway would provide the opposite.
    if profile.role.is_read_only() && permission_mode.is_none() {
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

async fn git_conn(app_state: &Arc<AppState>, project_id: i32) -> Result<GitConnection, String> {
    let (_, conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    Ok(conn)
}

#[tauri::command]
#[specta::specta]
pub async fn list_agent_profiles(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<ProfilesDocument, String> {
    let conn = git_conn(&app_state, project_id).await?;
    Ok(read_maestro_json(&conn, PROFILES_FILE).await)
}

/// Replace the whole document.
///
/// Whole-document rather than per-profile because the file is committed and hand-edited: a
/// partial update would have to reconcile with whatever a teammate's commit did to the rest of it,
/// and the UI already holds the full list.
#[tauri::command]
#[specta::specta]
pub async fn save_agent_profiles(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    document: ProfilesDocument,
) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for profile in &document.profiles {
        if profile.id.trim().is_empty() {
            return Err("Every profile needs an id".to_string());
        }
        if !seen.insert(profile.id.clone()) {
            return Err(format!("Duplicate profile id '{}'", profile.id));
        }
    }

    let conn = git_conn(&app_state, project_id).await?;
    crate::core::project_storage::ensure_project_storage(&conn).await?;
    write_maestro_json(&conn, PROFILES_FILE, &document).await
}

/// Resolve the profile for a role and reduce it to what the agent can honour.
///
/// Takes the agent's advertised capabilities as arguments rather than looking them up, because
/// they are only known once the session has spawned and reported them — and the caller holding
/// that report is the frontend. Keeping the reduction here rather than there is what stops the
/// read-only correction being reimplemented, and differently, per call site.
///
/// `None` means the project has no profile for the role, which is not an error: profiles are
/// opt-in and a project without them keeps the per-task settings it already had.
#[tauri::command]
#[specta::specta]
pub async fn resolve_agent_profile(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    role: AgentRole,
    profile_id: Option<String>,
    model_ids: Vec<String>,
    mode_ids: Vec<String>,
    supports_effort: bool,
) -> Result<Option<ResolvedProfile>, String> {
    let conn = git_conn(&app_state, project_id).await?;
    let document: ProfilesDocument = read_maestro_json(&conn, PROFILES_FILE).await;

    let Some(profile) = document.resolve(role, profile_id.as_deref()) else {
        return Ok(None);
    };

    let capabilities = AgentCapabilities { model_ids, mode_ids, supports_effort };
    apply_capabilities(profile, &capabilities).map(Some)
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

    #[test]
    fn resolution_prefers_an_override_then_the_default_then_the_role() {
        let mut only = profile(AgentRole::Reviewer);
        only.id = "strict".to_string();
        let mut lenient = profile(AgentRole::Reviewer);
        lenient.id = "lenient".to_string();

        let mut doc = ProfilesDocument {
            profiles: vec![only.clone(), lenient.clone()],
            defaults: Default::default(),
        };

        // No default set: the first profile declaring the role.
        assert_eq!(doc.resolve(AgentRole::Reviewer, None).unwrap().id, "strict");

        doc.defaults.insert("Reviewer".to_string(), "lenient".to_string());
        assert_eq!(doc.resolve(AgentRole::Reviewer, None).unwrap().id, "lenient");

        // An explicit choice beats the default.
        assert_eq!(doc.resolve(AgentRole::Reviewer, Some("strict")).unwrap().id, "strict");
    }

    /// An id that no longer exists must not silently pick something else — but it must not strand
    /// the task either, so it falls through to the ordinary resolution.
    #[test]
    fn an_unknown_override_falls_through_rather_than_failing() {
        let doc = ProfilesDocument {
            profiles: vec![profile(AgentRole::Coder)],
            defaults: Default::default(),
        };
        assert_eq!(doc.resolve(AgentRole::Coder, Some("deleted")).unwrap().id, "coder");
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
    fn a_fully_supported_profile_resolves_without_warnings() {
        let mut p = profile(AgentRole::Reviewer);
        p.model = Some("opus".to_string());
        p.effort = Some("high".to_string());

        let resolved = apply_capabilities(&p, &capable()).unwrap();
        assert!(resolved.warnings.is_empty(), "{:?}", resolved.warnings);
        assert_eq!(resolved.model.as_deref(), Some("opus"));
        assert_eq!(resolved.permission_mode.as_deref(), Some("readonly"));
    }

    /// Degrading rather than failing is what keeps a committed profile usable by a teammate whose
    /// agent differs.
    #[test]
    fn unsupported_fields_are_dropped_with_a_warning() {
        let mut p = profile(AgentRole::Coder);
        p.model = Some("gpt-9".to_string());
        p.effort = Some("high".to_string());
        p.permission_mode = Some("acceptEdits".to_string());

        let capabilities = AgentCapabilities {
            model_ids: vec!["sonnet".to_string()],
            mode_ids: vec!["acceptEdits".to_string()],
            supports_effort: false,
        };

        let resolved = apply_capabilities(&p, &capabilities).unwrap();
        assert_eq!(resolved.model, None);
        assert_eq!(resolved.effort, None);
        assert_eq!(resolved.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(resolved.warnings.len(), 2, "{:?}", resolved.warnings);
    }

    /// An agent that reports no modes has not told us it lacks ours. Treating silence as absence
    /// would drop the mode for every agent that does not advertise.
    #[test]
    fn unknown_capabilities_are_not_treated_as_missing_ones() {
        let p = profile(AgentRole::Reviewer);
        let resolved = apply_capabilities(&p, &AgentCapabilities::default()).unwrap();

        assert_eq!(resolved.permission_mode.as_deref(), Some("readonly"));
        assert!(resolved.warnings.is_empty(), "{:?}", resolved.warnings);
    }

    /// The case `Fail` exists for: a reviewer that cannot be held read-only is not a reviewer, and
    /// spawning it anyway would hand a read-only role write access.
    #[test]
    fn a_read_only_role_that_cannot_be_held_read_only_is_reported() {
        let mut p = profile(AgentRole::Reviewer);
        p.permission_mode = Some("readonly".to_string());

        let capabilities = AgentCapabilities {
            mode_ids: vec!["acceptEdits".to_string()],
            ..Default::default()
        };

        let warned = apply_capabilities(&p, &capabilities).unwrap();
        assert_eq!(warned.permission_mode, None);
        assert_eq!(warned.warnings.len(), 2, "{:?}", warned.warnings);

        p.fallback_behaviour = FallbackBehaviour::Fail;
        assert!(apply_capabilities(&p, &capabilities).is_err());
    }

    /// The coder is the one role that may legitimately run with the agent's default mode.
    #[test]
    fn the_coder_is_not_forced_read_only() {
        let mut p = profile(AgentRole::Coder);
        p.permission_mode = None;

        let resolved = apply_capabilities(&p, &capable()).unwrap();
        assert!(resolved.warnings.is_empty(), "{:?}", resolved.warnings);
    }
}
