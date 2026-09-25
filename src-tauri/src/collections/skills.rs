//! Skills in Collections: the app's half.
//!
//! The library and the per-agent installs are the daemon's (`maestro-server/src/skills.rs`),
//! for the same reason MCP servers are: they belong to the machine the agents run on. What is
//! done here is what needs the internet or knows the `SKILL.md` format: the catalog, downloading
//! a catalog skill's files, and writing and reading frontmatter.
//!
//! The catalog is skills.sh: its all-time leaderboard, most installed first, when nothing is
//! searched, and its search when something is. The leaderboard endpoint is the one the skills.sh
//! site pages through itself, undocumented, so a change there empties the list rather than breaking
//! anything else. A skill's files come from the skills.sh download endpoint the skills CLI uses,
//! which is also where a card's description is read; GitHub's trees API (60 calls an hour
//! unauthenticated) and `raw.githubusercontent.com` are only the fallback for an install.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::State;

use crate::acp::connection_server::{
    query_apply_skill_via_server, query_delete_skill_via_server, query_list_skills_via_server,
};
use crate::acp::ConnectionKey;
use crate::core::AppState;

/// A skill the size of this is not a skill; it keeps a bad download off the wire.
const MAX_SKILL_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// `SKILL.md` without its frontmatter.
    pub instructions: String,
    /// `owner/repo` for a catalog skill, which is not edited in Maestro.
    pub source: Option<String>,
    /// Maestro agent id to whether the skill is installed for it.
    pub agents: BTreeMap<String, bool>,
}

/// A skill Maestro lists but does not manage: one of its own, or one the project carries.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ListedSkill {
    pub name: String,
    pub description: String,
    /// Where it lives: `.claude/skills/review` in the project, or `Maestro`.
    pub location: String,
    /// Maestro agent ids that see it. Empty means every agent.
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SkillLibrary {
    pub skills: Vec<SkillInfo>,
    /// Agents the skills CLI can install for; the others are drawn disabled.
    pub supported_agents: Vec<String>,
    /// Maestro's own skills, installed for every agent on every connection it preflights.
    pub builtin: Vec<ListedSkill>,
    /// Skills in the project's agent directories.
    pub project: Vec<ListedSkill>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SkillCatalogEntry {
    /// `owner/repo/skill`.
    pub id: String,
    pub source: String,
    pub skill_id: String,
    pub name: String,
    pub installs: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SkillCatalogPage {
    pub entries: Vec<SkillCatalogEntry>,
    /// The leaderboard page to ask for next, while there is one. A search is a single page.
    pub next_page: Option<u32>,
}

#[tauri::command]
#[specta::specta]
pub async fn list_skills(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    project_path: Option<String>,
) -> Result<SkillLibrary, String> {
    let list = query_list_skills_via_server(connection, project_path, &app_state).await?;
    Ok(SkillLibrary {
        skills: list
            .skills
            .into_iter()
            .map(|skill| {
                let parsed = parse_skill_md(&skill.skill_md);
                SkillInfo {
                    description: parsed.description.unwrap_or_default(),
                    instructions: parsed.body,
                    name: skill.name,
                    source: skill.source,
                    agents: skill.agents,
                }
            })
            .collect(),
        supported_agents: list.supported_agents,
        builtin: crate::acp::skills::bundled()
            .iter()
            .filter(|file| file.path.ends_with("/SKILL.md"))
            .map(|file| {
                let parsed = parse_skill_md(&file.contents);
                ListedSkill {
                    name: parsed
                        .name
                        .unwrap_or_else(|| file.path.trim_end_matches("/SKILL.md").to_string()),
                    description: parsed.description.unwrap_or_default(),
                    location: "Maestro".to_string(),
                    agents: Vec::new(),
                }
            })
            .collect(),
        project: list
            .project
            .into_iter()
            .map(|skill| {
                let parsed = parse_skill_md(&skill.skill_md);
                ListedSkill {
                    name: parsed.name.unwrap_or(skill.name),
                    description: parsed.description.unwrap_or_default(),
                    location: skill.dir,
                    agents: skill.agents,
                }
            })
            .collect(),
    })
}

/// Create or rewrite a skill written in Maestro, and install it for the agents switched on.
#[tauri::command]
#[specta::specta]
pub async fn save_skill(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    name: String,
    description: String,
    instructions: String,
    agents: BTreeMap<String, bool>,
) -> Result<(), String> {
    validate_name(&name)?;
    if description.trim().is_empty() {
        return Err("A skill needs a description: it is how an agent knows when to use it".into());
    }
    query_apply_skill_via_server(
        connection,
        maestro_protocol::ApplySkillRequest {
            files: Some(vec![maestro_protocol::SkillFile {
                path: "SKILL.md".to_string(),
                contents: render_skill_md(&name, &description, &instructions),
            }]),
            name,
            source: None,
            agents,
        },
        &app_state,
    )
    .await
}

/// Install or remove a skill per agent, leaving its files alone.
#[tauri::command]
#[specta::specta]
pub async fn set_skill_agents(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    name: String,
    agents: BTreeMap<String, bool>,
) -> Result<(), String> {
    query_apply_skill_via_server(
        connection,
        maestro_protocol::ApplySkillRequest {
            name,
            files: None,
            source: None,
            agents,
        },
        &app_state,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_skill(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    name: String,
) -> Result<(), String> {
    query_delete_skill_via_server(connection, name, &app_state).await
}

/// Download a catalog skill into the connection's library and install it for `agents`.
#[tauri::command]
#[specta::specta]
pub async fn install_catalog_skill(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    source: String,
    skill_id: String,
    agents: BTreeMap<String, bool>,
) -> Result<(), String> {
    validate_name(&skill_id)?;
    let files = match skills_sh_files(&source, &skill_id).await {
        Ok(files) => files,
        Err(e) => {
            log::warn!("[skills] skills.sh download failed, reading GitHub instead: {e}");
            download_skill(&source, &skill_id).await?
        }
    };
    query_apply_skill_via_server(
        connection,
        maestro_protocol::ApplySkillRequest {
            name: skill_id,
            files: Some(files),
            source: Some(source),
            agents,
        },
        &app_state,
    )
    .await
}

/// The most installed skills with no query, a page of 200 at a time; a skills.sh search with one
/// of two characters or more. Both most installed first.
#[tauri::command]
#[specta::specta]
pub async fn skills_catalog(
    query: Option<String>,
    page: Option<u32>,
) -> Result<SkillCatalogPage, String> {
    match query
        .map(|query| query.trim().to_string())
        .filter(|query| !query.is_empty())
    {
        Some(query) if query.chars().count() < 2 => Ok(SkillCatalogPage {
            entries: Vec::new(),
            next_page: None,
        }),
        Some(query) => {
            let url = format!(
                "https://skills.sh/api/search?q={}&limit=100",
                urlencoding::encode(&query)
            );
            let mut page = catalog_page(&url, None).await?;
            page.entries
                .sort_by_key(|entry| std::cmp::Reverse(entry.installs.unwrap_or(0)));
            Ok(page)
        }
        None => {
            let page = page.unwrap_or(0);
            let url = format!("https://skills.sh/api/skills/all-time/{page}");
            catalog_page(&url, Some(page)).await
        }
    }
}

async fn get(url: &str) -> Result<reqwest::Response, String> {
    crate::integration::providers::http_client()?
        .get(url)
        .header("User-Agent", "maestro")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("{url} could not be fetched: {e}"))
}

/// One skills.sh listing. `page` is the leaderboard page asked for, which pages on while the
/// answer says `hasMore`.
async fn catalog_page(url: &str, page: Option<u32>) -> Result<SkillCatalogPage, String> {
    let found: Value = get(url)
        .await?
        .json()
        .await
        .map_err(|e| format!("skills.sh sent something unexpected: {e}"))?;
    let more = found.get("hasMore").and_then(Value::as_bool) == Some(true);
    Ok(SkillCatalogPage {
        entries: found
            .get("skills")
            .and_then(Value::as_array)
            .map(|skills| skills.iter().filter_map(catalog_entry).collect())
            .unwrap_or_default(),
        next_page: page.filter(|_| more).map(|page| page + 1),
    })
}

/// A listed skill, or `None` for one Maestro cannot download: installing reads the repository
/// from GitHub, so only an `owner/repo` source will do.
fn catalog_entry(skill: &Value) -> Option<SkillCatalogEntry> {
    let source = skill.get("source")?.as_str()?.to_string();
    if source.split('/').count() != 2 {
        return None;
    }
    let skill_id = skill.get("skillId")?.as_str()?.to_string();
    Some(SkillCatalogEntry {
        id: format!("{source}/{skill_id}"),
        name: skill
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&skill_id)
            .to_string(),
        installs: skill
            .get("installs")
            .and_then(Value::as_u64)
            .map(|n| n.min(u32::MAX as u64) as u32),
        source,
        skill_id,
    })
}

fn blobs(tree: &Value) -> Vec<String> {
    tree.get("tree")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|i| i.get("type").and_then(Value::as_str) == Some("blob"))
                .filter_map(|i| i.get("path")?.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn raw_url(source: &str, path: &str) -> String {
    format!("https://raw.githubusercontent.com/{source}/HEAD/{path}")
}

async fn fetch_text(url: &str) -> Result<String, String> {
    get(url)
        .await?
        .text()
        .await
        .map_err(|e| format!("{url} could not be read: {e}"))
}

/// A catalog skill's description, read from its `SKILL.md`. Asked per card as it scrolls into
/// view, since the listings carry none.
#[tauri::command]
#[specta::specta]
pub async fn skill_description(source: String, skill_id: String) -> Result<Option<String>, String> {
    let files = skills_sh_files(&source, &skill_id).await?;
    Ok(files
        .iter()
        .find(|file| file.path == "SKILL.md")
        .and_then(|file| parse_skill_md(&file.contents).description))
}

/// Every file of a catalog skill, from the download endpoint the skills CLI itself uses: one call,
/// no GitHub rate limit, paths relative to the skill's directory.
async fn skills_sh_files(
    source: &str,
    skill_id: &str,
) -> Result<Vec<maestro_protocol::SkillFile>, String> {
    let (owner, repo) = source
        .split_once('/')
        .ok_or_else(|| format!("{source} is not an owner/repo source"))?;
    let url = format!(
        "https://skills.sh/api/download/{}/{}/{}",
        urlencoding::encode(owner),
        urlencoding::encode(repo),
        urlencoding::encode(skill_id)
    );
    let found: Value = get(&url)
        .await?
        .json()
        .await
        .map_err(|e| format!("skills.sh sent something unexpected: {e}"))?;
    let files = skill_files(&found)?;
    let total: usize = files.iter().map(|file| file.contents.len()).sum();
    if total > MAX_SKILL_BYTES {
        return Err(format!("{skill_id} is larger than {MAX_SKILL_BYTES} bytes"));
    }
    Ok(files)
}

fn skill_files(found: &Value) -> Result<Vec<maestro_protocol::SkillFile>, String> {
    let files: Vec<maestro_protocol::SkillFile> = found
        .get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|file| {
                    Some(maestro_protocol::SkillFile {
                        path: file.get("path")?.as_str()?.to_string(),
                        contents: file.get("contents")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if files.iter().any(|file| file.path == "SKILL.md") {
        Ok(files)
    } else {
        Err("skills.sh returned no SKILL.md".to_string())
    }
}

/// Every text file in the directory whose `SKILL.md` is named `skill_id`, relative to it.
async fn download_skill(
    source: &str,
    skill_id: &str,
) -> Result<Vec<maestro_protocol::SkillFile>, String> {
    let url = format!("https://api.github.com/repos/{source}/git/trees/HEAD?recursive=1");
    let tree: Value = get(&url)
        .await?
        .json()
        .await
        .map_err(|e| format!("GitHub sent something unexpected for {source}: {e}"))?;
    let all = blobs(&tree);
    // The directory is usually named after the skill, so those are read first.
    let mut candidates: Vec<&String> = all
        .iter()
        .filter(|p| p.as_str() == "SKILL.md" || p.ends_with("/SKILL.md"))
        .collect();
    candidates.sort_by_key(|p| !p.ends_with(&format!("{skill_id}/SKILL.md")));
    let mut found = None;
    for path in candidates {
        let contents = fetch_text(&raw_url(source, path)).await?;
        if parse_skill_md(&contents).name.as_deref() == Some(skill_id) {
            found = Some(path.trim_end_matches("SKILL.md").to_string());
            break;
        }
    }
    let dir = found.ok_or_else(|| format!("{source} has no skill named {skill_id}"))?;

    let mut files = Vec::new();
    let mut total = 0;
    for path in all.iter().filter(|p| p.starts_with(&dir)) {
        let bytes = get(&raw_url(source, path))
            .await?
            .bytes()
            .await
            .map_err(|e| format!("{path} could not be read: {e}"))?;
        total += bytes.len();
        if total > MAX_SKILL_BYTES {
            return Err(format!("{skill_id} is larger than {MAX_SKILL_BYTES} bytes"));
        }
        // ponytail: skill files travel as text, so a binary asset (an image, a font) is left out.
        // Carry bytes in `SkillFile` if a skill that needs one turns up.
        match String::from_utf8(bytes.to_vec()) {
            Ok(contents) => files.push(maestro_protocol::SkillFile {
                path: path[dir.len()..].to_string(),
                contents,
            }),
            Err(_) => log::warn!("[skills] {source}/{path} is not text and was left out"),
        }
    }
    Ok(files)
}

fn validate_name(name: &str) -> Result<(), String> {
    let valid = (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if valid {
        Ok(())
    } else {
        Err("A skill name is 1 to 64 lowercase letters, digits and hyphens".to_string())
    }
}

/// A JSON string is a valid YAML double-quoted scalar, which makes it the one quoting that needs
/// no rules of its own.
fn render_skill_md(name: &str, description: &str, instructions: &str) -> String {
    let description = serde_json::to_string(description.trim()).unwrap_or_default();
    format!(
        "---\nname: {name}\ndescription: {description}\n---\n\n{}\n",
        instructions.trim()
    )
}

#[derive(Debug, Default, PartialEq)]
struct ParsedSkill {
    name: Option<String>,
    description: Option<String>,
    body: String,
}

/// `name` and `description` from `SKILL.md` frontmatter, and what follows it.
///
/// ponytail: reads single-line scalars (plain, single- or double-quoted) and `>`/`|` blocks,
/// which is what skill frontmatter uses in practice. A YAML parser if anything stranger appears.
fn parse_skill_md(text: &str) -> ParsedSkill {
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return ParsedSkill {
            body: text.trim().to_string(),
            ..ParsedSkill::default()
        };
    };
    let (front, body) = match rest.find("\n---") {
        Some(end) => {
            let after = &rest[end + 4..];
            (&rest[..end], after.split_once('\n').map_or("", |(_, b)| b))
        }
        None => (rest, ""),
    };
    let lines: Vec<&str> = front.lines().collect();
    let field = |key: &str| -> Option<String> {
        let at = lines
            .iter()
            .position(|l| l.strip_prefix(key).is_some_and(|r| r.starts_with(':')))?;
        let value = lines[at][key.len() + 1..].trim();
        if value.is_empty() || value.starts_with('>') || value.starts_with('|') {
            let joiner = if value.starts_with('|') { "\n" } else { " " };
            let block: Vec<&str> = lines[at + 1..]
                .iter()
                .take_while(|l| l.starts_with(' ') || l.starts_with('\t') || l.is_empty())
                .map(|l| l.trim())
                .collect();
            return Some(block.join(joiner).trim().to_string());
        }
        if value.starts_with('"') {
            return serde_json::from_str(value)
                .ok()
                .or_else(|| Some(value.to_string()));
        }
        if let Some(inner) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
            return Some(inner.replace("''", "'"));
        }
        Some(value.to_string())
    };
    ParsedSkill {
        name: field("name"),
        description: field("description"),
        body: body.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rendered_skill_parses_back() {
        let md = render_skill_md("my-skill", "Use when \"quoted\": always", "Do the thing.\n");
        let parsed = parse_skill_md(&md);
        assert_eq!(parsed.name.as_deref(), Some("my-skill"));
        assert_eq!(
            parsed.description.as_deref(),
            Some("Use when \"quoted\": always")
        );
        assert_eq!(parsed.body, "Do the thing.");
    }

    #[test]
    fn frontmatter_blocks_and_quotes_are_read() {
        let md = "---\nname: pdf\ndescription: >\n  Read PDFs\n  and fill forms.\nlicense: 'Apache'\n---\n# PDF\n";
        let parsed = parse_skill_md(md);
        assert_eq!(parsed.name.as_deref(), Some("pdf"));
        assert_eq!(
            parsed.description.as_deref(),
            Some("Read PDFs and fill forms.")
        );
        assert_eq!(parsed.body, "# PDF");
        let single = parse_skill_md("---\nname: 'it''s'\n---\nbody");
        assert_eq!(single.name.as_deref(), Some("it's"));
    }

    #[test]
    fn a_file_without_frontmatter_is_all_body() {
        let parsed = parse_skill_md("just text");
        assert_eq!(parsed.name, None);
        assert_eq!(parsed.body, "just text");
    }

    #[test]
    fn downloads_need_a_skill_md() {
        let found = serde_json::json!({ "files": [
            { "path": "SKILL.md", "contents": "---
name: pdf
---
" },
            { "path": "scripts/a.py", "contents": "x" }
        ]});
        assert_eq!(skill_files(&found).expect("files").len(), 2);
        assert!(skill_files(&serde_json::json!({ "files": [] })).is_err());
    }

    #[test]
    fn catalog_listings_map_to_entries() {
        assert!(catalog_entry(&serde_json::json!({
            "source": "uizze.sh", "skillId": "ios-design", "name": "ios-design", "installs": 85
        }))
        .is_none());
        let entry = catalog_entry(&serde_json::json!({
            "id": "anthropics/skills/pdf", "source": "anthropics/skills",
            "skillId": "pdf", "name": "pdf", "installs": 200826
        }))
        .expect("entry");
        assert_eq!(entry.id, "anthropics/skills/pdf");
        assert_eq!(entry.installs, Some(200826));
    }
}
