//! Agent profiles: what an agent *is* for a given role on a project, read from the committed
//! `.maestro/profiles.json`. The app edits the file and the daemon starts stages from it; both
//! resolve a role to a profile here, so they cannot disagree about which one a stage runs on.
//!
//! A role is not an agent: "review" means something different in every codebase, and the thing
//! that makes it mean anything is the prompt and the permissions it runs under. A profile bundles
//! those with the agent and model, so a project can say "the reviewer is a different model from the
//! coder, reads only, and looks for these things" once rather than per task.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::completion::review_rounds_remain;
use crate::AgentRole;

pub const PROFILES_FILE: &str = "profiles.json";

/// What a profile does when the agent it names cannot honour part of it.
///
/// Agents differ in which models and permission modes they expose, and `effort` is not universal
/// at all. Failing the spawn over an unsupported field would make a shared profile unusable for
/// anyone whose agent differs slightly, so the default is to carry on and say so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum FallbackBehaviour {
    /// Drop the unsupported field, spawn anyway, warn the user.
    #[default]
    Warn,
    /// Refuse to spawn. For a profile whose whole point is the field that is missing: a read-only
    /// reviewer on an agent with no read-only mode is not a reviewer.
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub role: AgentRole,
    pub agent_id: String,
    #[serde(default)]
    pub model: Option<String>,
    /// Not ACP-universal: agents that do not expose it drop it per `fallback_behaviour`.
    #[serde(default)]
    pub effort: Option<String>,
    /// The ACP session mode id. `None` means "whatever the agent defaults to", which is only
    /// appropriate for the coder.
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    /// What the role means for this project. The field that makes a profile worth having: without
    /// it every project gets a generic reviewer.
    #[serde(default)]
    pub role_prompt: Option<String>,
    #[serde(default)]
    pub fallback_behaviour: FallbackBehaviour,
}

/// The project's profiles, plus which one each role uses by default.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ProfilesDocument {
    #[serde(default)]
    pub profiles: Vec<AgentProfile>,
    /// Role → profile id. A role with no entry falls back to the first profile declaring it.
    #[serde(default)]
    pub defaults: HashMap<String, String>,
}

impl ProfilesDocument {
    /// The profile to use for a role, given an optional explicit override.
    ///
    /// Resolution order is override → project default → the first profile declaring the role.
    /// The last step is what keeps a project usable after someone adds a reviewer profile without
    /// also remembering to mark it as the default. An override naming a profile that no longer
    /// exists falls through rather than stranding the task.
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

/// The role's name as `defaults` and a task's `profile_overrides` key it: its serde name.
fn role_key(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Refiner => "Refiner",
        AgentRole::Planner => "Planner",
        AgentRole::Coder => "Coder",
        AgentRole::Reviewer => "Reviewer",
        AgentRole::Judge => "Judge",
        AgentRole::Preparer => "Preparer",
        AgentRole::Worker => "Worker",
    }
}

/// A task's `profile_overrides`: role name → a profile id, or null for "skip this stage".
fn overrides(overrides_json: Option<&str>) -> Option<HashMap<String, Option<String>>> {
    serde_json::from_str(overrides_json?).ok()
}

/// Whether the task turned this role off: a present key with a null value. Unreadable JSON is
/// `false`, since a parse failure is not a reason to skip a stage.
pub fn role_is_skipped(overrides_json: Option<&str>, role: AgentRole) -> bool {
    overrides(overrides_json).is_some_and(|map| matches!(map.get(role_key(role)), Some(None)))
}

/// The profile id a task's `profile_overrides` names for `role`, if any.
pub fn overridden_profile(overrides_json: Option<&str>, role: AgentRole) -> Option<String> {
    overrides(overrides_json)?.remove(role_key(role)).flatten()
}

/// Whether a reviewer looks before the user once a coder's turn completes.
///
/// Three conditions, all necessary. The project must define a `Reviewer` profile, which is how a
/// team opts in: a project without one keeps the pipeline it had. The task must not have turned
/// the stage off for itself, which is the same opt-out one task at a time. And the loop must have
/// rounds left, or a reviewer would be started only to have its verdict escalated anyway. So the
/// work of the last rework round reaches the user unreviewed, deliberately: by then they are the
/// reviewer, and the alternative is paying an agent for a verdict nobody may act on.
pub fn reviewer_should_run(
    review_rounds: i32,
    profile_overrides: Option<&str>,
    profiles: &ProfilesDocument,
) -> bool {
    review_rounds_remain(review_rounds)
        && !role_is_skipped(profile_overrides, AgentRole::Reviewer)
        && profiles.resolve(AgentRole::Reviewer, None).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, role: AgentRole) -> AgentProfile {
        AgentProfile {
            id: id.to_string(),
            name: id.to_string(),
            role,
            agent_id: "claude".to_string(),
            model: None,
            effort: None,
            permission_mode: None,
            skills: vec![],
            mcp_servers: vec![],
            role_prompt: None,
            fallback_behaviour: FallbackBehaviour::Warn,
        }
    }

    fn document(profiles: Vec<AgentProfile>) -> ProfilesDocument {
        ProfilesDocument {
            profiles,
            defaults: HashMap::new(),
        }
    }

    #[test]
    fn resolution_prefers_an_override_then_the_default_then_the_role() {
        let mut doc = document(vec![
            profile("strict", AgentRole::Reviewer),
            profile("lenient", AgentRole::Reviewer),
        ]);
        // No default set: the first profile declaring the role.
        assert_eq!(doc.resolve(AgentRole::Reviewer, None).unwrap().id, "strict");

        doc.defaults
            .insert("Reviewer".to_string(), "lenient".to_string());
        assert_eq!(
            doc.resolve(AgentRole::Reviewer, None).unwrap().id,
            "lenient"
        );
        // An explicit choice beats the default.
        assert_eq!(
            doc.resolve(AgentRole::Reviewer, Some("strict")).unwrap().id,
            "strict"
        );
        // An id that no longer exists falls through to the ordinary resolution.
        assert_eq!(
            doc.resolve(AgentRole::Reviewer, Some("deleted"))
                .unwrap()
                .id,
            "lenient"
        );
        assert!(doc.resolve(AgentRole::Planner, None).is_none());
    }

    /// The three states the map can put a role in, plus the one it cannot be trusted to.
    #[test]
    fn only_a_present_null_marks_a_role_as_skipped() {
        let json = r#"{"Planner": null, "Reviewer": "strict"}"#;

        assert!(role_is_skipped(Some(json), AgentRole::Planner));
        // Named, so it runs.
        assert!(!role_is_skipped(Some(json), AgentRole::Reviewer));
        // Absent, so the project decides, which is not the same as "off".
        assert!(!role_is_skipped(Some(json), AgentRole::Refiner));

        assert!(!role_is_skipped(None, AgentRole::Planner));
        assert!(!role_is_skipped(Some("{"), AgentRole::Planner));
        assert!(!role_is_skipped(Some("[]"), AgentRole::Planner));

        assert_eq!(
            overridden_profile(Some(json), AgentRole::Reviewer).as_deref(),
            Some("strict")
        );
        assert_eq!(overridden_profile(Some(json), AgentRole::Planner), None);
    }

    #[test]
    fn a_reviewer_runs_only_when_the_project_has_one_the_task_wants_it_and_rounds_remain() {
        let with = document(vec![profile("strict", AgentRole::Reviewer)]);
        assert!(reviewer_should_run(0, None, &with));
        assert!(!reviewer_should_run(0, None, &document(vec![])));
        assert!(!reviewer_should_run(
            0,
            Some(r#"{"Reviewer": null}"#),
            &with
        ));
        assert!(!reviewer_should_run(
            crate::completion::REVIEW_ROUND_CAP,
            None,
            &with
        ));
    }

    #[test]
    fn only_the_coder_the_worker_and_the_preparer_write() {
        for role in [AgentRole::Coder, AgentRole::Worker, AgentRole::Preparer] {
            assert!(!role.is_read_only(), "{role:?}");
        }
        for role in [
            AgentRole::Refiner,
            AgentRole::Planner,
            AgentRole::Reviewer,
            AgentRole::Judge,
        ] {
            assert!(role.is_read_only(), "{role:?}");
        }
    }
}
