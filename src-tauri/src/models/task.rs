use serde::{Deserialize, Serialize};
use specta::Type;
use std::str::FromStr;

/// SQL SELECT clause for all task columns, matching Task::from_row column order.
///
/// Column order: id(0), project_id(1), name(2), description(3), acceptance_criteria(4),
/// status(5), priority(6), origin_branch(7), archived_at(8), external_id(9),
/// is_imported(10), import_source(11), skills(12), model_override(13),
/// mcp_allowlist(14), skills_override(15), created_at(16), updated_at(17)
pub const TASK_SELECT: &str =
    "SELECT id, project_id, name, description, acceptance_criteria, status, priority, \
     origin_branch, archived_at, external_id, is_imported, import_source, skills, \
     model_override, mcp_allowlist, skills_override, created_at, updated_at FROM tasks";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct Task {
    pub id: i32,
    pub project_id: i32,
    pub name: String,
    pub description: String,
    #[specta(optional)]
    pub acceptance_criteria: Option<String>,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    #[specta(optional)]
    pub origin_branch: Option<String>,
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
    pub created_at: String,
    pub updated_at: String,
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
#[serde(rename_all = "PascalCase")]
pub enum TaskPriority {
    Urgent,
    High,
    Medium,
    Low,
}

impl FromStr for TaskPriority {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Urgent" => Ok(TaskPriority::Urgent),
            "High" => Ok(TaskPriority::High),
            "Medium" => Ok(TaskPriority::Medium),
            "Low" => Ok(TaskPriority::Low),
            _ => {
                eprintln!("Unknown TaskPriority '{}', defaulting to Medium", s);
                Ok(TaskPriority::Medium)
            }
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
                eprintln!("Unknown TaskStatus '{}', defaulting to Backlog", s);
                Ok(TaskStatus::Backlog)
            }
        }
    }
}

impl Task {
    /// Column order matches TASK_SELECT constant defined in this file:
    /// id(0), project_id(1), name(2), description(3), acceptance_criteria(4),
    /// status(5), priority(6), origin_branch(7), archived_at(8),
    /// external_id(9), is_imported(10), import_source(11), skills(12),
    /// model_override(13), mcp_allowlist(14), skills_override(15),
    /// created_at(16), updated_at(17)
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Task {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            description: row.get(3)?,
            acceptance_criteria: row.get(4)?,
            status: row.get::<_, String>(5)?.parse().unwrap_or(TaskStatus::Backlog),
            priority: row.get::<_, String>(6)?.parse().unwrap_or(TaskPriority::Medium),
            origin_branch: row.get(7)?,
            archived_at: row.get(8)?,
            external_id: row.get(9)?,
            is_imported: row.get(10)?,
            import_source: row.get(11)?,
            skills: serde_json::from_str(&row.get::<_, String>(12)?).unwrap_or_default(),
            model_override: row.get(13)?,
            mcp_allowlist: row.get::<_, Option<String>>(14)?.and_then(|s| serde_json::from_str(&s).ok()),
            skills_override: row.get::<_, Option<String>>(15)?.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: row.get(16)?,
            updated_at: row.get(17)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct CreateTaskRequest {
    pub project_id: i32,
    pub name: String,
    pub description: String,
    pub acceptance_criteria: String,
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
    pub model_default: String,
    pub mcp_allowlist: Vec<String>,
    pub skills_default: Vec<String>,
}

// TODO: ProjectConfigRequest and ProjectConfigResponse have identical fields.
// Cannot deduplicate to a type alias because both need #[derive(TS)] / #[specta(export)]
// for TypeScript binding generation. Consider consolidating if specta adds alias support.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectConfigRequest {
    pub model_default: String,
    pub mcp_allowlist: Vec<String>,
    pub skills_default: Vec<String>,
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
}
