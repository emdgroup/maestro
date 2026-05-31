use serde::{Deserialize, Serialize};
use specta::Type;
use std::str::FromStr;

/// SQL SELECT clause for all task columns, matching Task::from_row column order.
///
/// Column order: id(0), project_id(1), title(2), description(3), status(4), priority(5),
/// base_branch(6), archived_at(7), external_id(8), is_imported(9), import_source(10),
/// skills(11), model_override(12), mcp_allowlist(13), skills_override(14), labels(15),
/// external_url(16), external_updated_at(17), created_at(18), updated_at(19),
/// auto_approve(20), isolated_worktree(21), agent_id(22), permission_mode_override(23)
pub const TASK_SELECT: &str =
    "SELECT id, project_id, title, description, status, priority, \
     base_branch, archived_at, external_id, is_imported, import_source, skills, \
     model_override, mcp_allowlist, skills_override, labels, \
     external_url, external_updated_at, created_at, updated_at, \
     auto_approve, isolated_worktree, agent_id, permission_mode_override FROM tasks";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct Task {
    pub id: i32,
    pub project_id: i32,
    pub title: String,
    #[specta(optional)]
    pub description: Option<String>,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub base_branch: String,
    #[specta(optional)]
    pub archived_at: Option<String>,
    #[specta(optional)]
    pub external_id: Option<String>,
    #[specta(optional)]
    pub is_imported: Option<bool>,
    #[specta(optional)]
    pub import_source: Option<String>,
    pub skills: Vec<String>,
    #[specta(optional)]
    pub model_override: Option<String>,
    #[specta(optional)]
    pub mcp_allowlist: Option<Vec<String>>,
    #[specta(optional)]
    pub skills_override: Option<Vec<String>>,
    pub labels: Vec<String>,
    #[specta(optional)]
    pub external_url: Option<String>,
    #[specta(optional)]
    pub external_updated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub auto_approve: bool,
    pub isolated_worktree: bool,
    #[specta(optional)]
    pub agent_id: Option<String>,
    #[specta(optional)]
    pub permission_mode_override: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskRelationship {
    pub id: i32,
    pub from_task_id: i32,
    pub to_task_id: i32,
    pub relationship_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskInstruction {
    pub id: i32,
    pub task_id: i32,
    pub content: String,
    pub source: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskAttachment {
    pub id: i32,
    pub task_id: i32,
    pub filename: String,
    pub file_path: String,
    pub file_size: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum TaskPriority {
    Urgent,
    High,
    Medium,
    Low,
    None,
}

impl FromStr for TaskPriority {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Urgent" => Ok(TaskPriority::Urgent),
            "High" => Ok(TaskPriority::High),
            "Medium" => Ok(TaskPriority::Medium),
            "Low" => Ok(TaskPriority::Low),
            "None" => Ok(TaskPriority::None),
            _ => Ok(TaskPriority::Medium),
        }
    }
}

impl FromStr for TaskStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Backlog" => Ok(TaskStatus::Backlog),
            "Ready" => Ok(TaskStatus::Ready),
            "InProgress" => Ok(TaskStatus::InProgress),
            "Review" => Ok(TaskStatus::Review),
            "Done" => Ok(TaskStatus::Done),
            "Cancelled" => Ok(TaskStatus::Cancelled),
            _ => {
                Ok(TaskStatus::Backlog)
            }
        }
    }
}

impl Task {
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Task {
            id: row.get(0)?,
            project_id: row.get(1)?,
            title: row.get(2)?,
            description: row.get(3)?,
            status: row.get::<_, String>(4)?.parse().unwrap_or(TaskStatus::Backlog),
            priority: row.get::<_, String>(5)?.parse().unwrap_or(TaskPriority::Medium),
            base_branch: row.get::<_, String>(6)?,
            archived_at: row.get(7)?,
            external_id: row.get(8)?,
            is_imported: row.get(9)?,
            import_source: row.get(10)?,
            skills: serde_json::from_str(&row.get::<_, String>(11)?).unwrap_or_default(),
            model_override: row.get(12)?,
            mcp_allowlist: row.get::<_, Option<String>>(13)?.and_then(|s| serde_json::from_str(&s).ok()),
            skills_override: row.get::<_, Option<String>>(14)?.and_then(|s| serde_json::from_str(&s).ok()),
            labels: serde_json::from_str(&row.get::<_, String>(15).unwrap_or_else(|_| "[]".to_string())).unwrap_or_default(),
            external_url: row.get(16)?,
            external_updated_at: row.get(17)?,
            created_at: row.get(18)?,
            updated_at: row.get(19)?,
            auto_approve: row.get::<_, bool>(20).unwrap_or(false),
            isolated_worktree: row.get::<_, bool>(21).unwrap_or(true),
            agent_id: row.get(22)?,
            permission_mode_override: row.get(23)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct CreateTaskRequest {
    pub project_id: i32,
    pub title: String,
    #[specta(optional)]
    pub description: Option<String>,
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum TaskStatus {
    Backlog,
    Ready,
    InProgress,
    Review,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectConfigResponse {
    pub default_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectConfigRequest {
    pub default_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskConfigRequest {
    #[specta(optional)]
    pub model_override: Option<String>,
    #[specta(optional)]
    pub mcp_allowlist: Option<Vec<String>>,
    #[specta(optional)]
    pub skills_override: Option<Vec<String>>,
    #[specta(optional)]
    pub permission_mode_override: Option<String>,
}
