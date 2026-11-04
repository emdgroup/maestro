//! Agent profiles: reading and writing a project's profiles. The types, and which profile a role
//! resolves to, are `maestro_protocol::profiles`, shared with the daemon that starts the stages.
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

use crate::connectivity::GitConnection;
use crate::core::project_storage::{read_maestro_json, write_maestro_json};
use crate::core::AppState;

pub use maestro_protocol::profiles::{
    role_is_skipped, AgentProfile, FallbackBehaviour, ProfilesDocument, PROFILES_FILE,
};
pub use maestro_protocol::AgentRole;

/// Which pipeline role a session was started for, and the profile that role resolved to.
///
/// One type rather than two fields on the session because they are only meaningful together: a
/// profile id says nothing without the role that picked it, and it is absent whenever the role
/// ran on the project's default agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SessionRole {
    pub role: AgentRole,
    pub profile_id: Option<String>,
}

async fn git_conn(app_state: &Arc<AppState>, project_id: i32) -> Result<GitConnection, String> {
    let (_, conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    Ok(conn)
}

/// The project's profiles. A missing or unreadable file is the empty document.
pub(crate) async fn read_profiles(
    app_state: &AppState,
    project_id: i32,
) -> Result<ProfilesDocument, String> {
    let (_, conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    Ok(read_maestro_json(&conn, PROFILES_FILE).await)
}

#[tauri::command]
#[specta::specta]
pub async fn list_agent_profiles(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<ProfilesDocument, String> {
    read_profiles(&app_state, project_id).await
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

/// Give a project its starting profiles, unless it already has a `profiles.json`.
///
/// Returns whether it wrote. An existing file is kept even when it lists no profiles, because
/// that is a user who removed them, and a host that cannot say whether the file exists is an
/// error rather than a "no", so a flaky connection never writes over the user's profiles.
#[tauri::command]
#[specta::specta]
pub async fn seed_agent_profiles(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    document: ProfilesDocument,
) -> Result<bool, String> {
    let conn = git_conn(&app_state, project_id).await?;
    seed_profiles(&conn, &document).await
}

async fn seed_profiles(conn: &GitConnection, document: &ProfilesDocument) -> Result<bool, String> {
    let path = format!("{}/.maestro/{PROFILES_FILE}", conn.path());
    if crate::connectivity::files::try_exists(conn, &path).await? {
        return Ok(false);
    }
    crate::core::project_storage::ensure_project_storage(conn).await?;
    write_maestro_json(conn, PROFILES_FILE, document).await?;
    Ok(true)
}

/// Whether `role` resolves to a profile on this project, `profile_id` being the task's override
/// for it. The test the daemon makes before it runs the planner ahead of the coder.
#[tauri::command]
#[specta::specta]
pub async fn has_profile_for_role(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    role: AgentRole,
    profile_id: Option<String>,
) -> Result<bool, String> {
    Ok(read_profiles(&app_state, project_id)
        .await?
        .resolve(role, profile_id.as_deref())
        .is_some())
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

    /// Seeding fills a project that never had the file and leaves one the user emptied alone.
    #[tokio::test]
    async fn seeding_writes_only_when_the_file_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let conn = GitConnection::Local {
            path: dir.path().to_string_lossy().into_owned(),
        };
        let seed = ProfilesDocument {
            profiles: vec![profile(AgentRole::Coder)],
            defaults: Default::default(),
        };

        assert!(seed_profiles(&conn, &seed).await.unwrap());
        let written: ProfilesDocument = read_maestro_json(&conn, PROFILES_FILE).await;
        assert_eq!(written.profiles.len(), 1);

        write_maestro_json(&conn, PROFILES_FILE, &ProfilesDocument::default())
            .await
            .unwrap();
        assert!(!seed_profiles(&conn, &seed).await.unwrap());
        let kept: ProfilesDocument = read_maestro_json(&conn, PROFILES_FILE).await;
        assert!(kept.profiles.is_empty());
    }
}
