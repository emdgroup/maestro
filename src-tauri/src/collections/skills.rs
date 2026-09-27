//! Skills in Collections: the app's half.
//!
//! The library and the per-agent installs are the daemon's (`maestro-server/src/skills.rs`),
//! for the same reason MCP servers are: they belong to the machine the agents run on. What is
//! done here is what needs the internet or knows the `SKILL.md` format: the catalog and reading a
//! skill's name and description. A catalog skill is fetched by the daemon, with the skills CLI.
//! The editor writes the whole `SKILL.md` (`skills.ts`), so frontmatter Maestro has no field for is
//! kept.
//!
//! The catalog is skills.sh: its all-time leaderboard, most installed first, when nothing is
//! searched, and its search when something is. The whole leaderboard is ~50 pages of 200 against
//! a limit of 30 requests a minute, so it is paged in on demand rather than read at once. The
//! leaderboard endpoint is the one the skills.sh site pages through itself, undocumented, so a
//! change there empties the list rather than breaking anything else. No listing carries
//! descriptions: a card's summary is read from the skill's page, and the whole description, from
//! the download endpoint (60 requests an hour), only when the card is hovered.

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
/// The Agent Skills spec limit, in characters.
const MAX_DESCRIPTION: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// The whole file, frontmatter included. The editor reads and writes it.
    pub skill_md: String,
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
                    name: skill.name,
                    skill_md: skill.skill_md,
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
/// `skill_md` is stored as written, so frontmatter the editor does not know survives.
#[tauri::command]
#[specta::specta]
pub async fn save_skill(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    name: String,
    skill_md: String,
    agents: BTreeMap<String, bool>,
) -> Result<(), String> {
    validate_name(&name)?;
    let parsed = parse_skill_md(&skill_md);
    if parsed.name.as_deref() != Some(name.as_str()) {
        return Err(format!("The name in SKILL.md has to be {name}"));
    }
    let description = parsed.description.unwrap_or_default();
    if description.trim().is_empty() {
        return Err("A skill needs a description: it is how an agent knows when to use it".into());
    }
    if description.trim().chars().count() > MAX_DESCRIPTION {
        return Err(format!(
            "A skill description is at most {MAX_DESCRIPTION} characters"
        ));
    }
    query_apply_skill_via_server(
        connection,
        maestro_protocol::ApplySkillRequest {
            files: Some(vec![maestro_protocol::SkillFile {
                path: "SKILL.md".to_string(),
                contents: skill_md,
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

/// Install a catalog skill into the connection's library and for `agents`. The daemon fetches it
/// with the skills CLI, so the skill arrives whole, binary assets included.
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
    query_apply_skill_via_server(
        connection,
        maestro_protocol::ApplySkillRequest {
            name: skill_id,
            files: None,
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
            sort_search_results(&mut page.entries, &query);
            Ok(page)
        }
        None => {
            let page = page.unwrap_or(0);
            let url = format!("https://skills.sh/api/skills/all-time/{page}");
            catalog_page(&url, Some(page)).await
        }
    }
}

/// Most installed first, except that a skill named exactly what was typed leads: someone who typed
/// a whole name is looking for that skill, not the most popular one that also matched.
fn sort_search_results(entries: &mut [SkillCatalogEntry], query: &str) {
    entries.sort_by_key(|entry| {
        (
            !entry.name.eq_ignore_ascii_case(query) && !entry.skill_id.eq_ignore_ascii_case(query),
            std::cmp::Reverse(entry.installs.unwrap_or(0)),
        )
    });
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

/// The start of a catalog skill's description, from the `<meta name="description">` of its
/// skills.sh page, cut at about 160 characters and ending in `…` when it was. Asked per card as it
/// scrolls into view, since the listings carry none: the pages are served from a cache and are
/// not held to the download endpoint's 60 requests an hour.
#[tauri::command]
#[specta::specta]
pub async fn skill_summary(source: String, skill_id: String) -> Result<Option<String>, String> {
    let url = format!(
        "https://www.skills.sh/{source}/{}",
        urlencoding::encode(&skill_id)
    );
    Ok(meta_description(&fetch_page(&url).await?))
}

async fn fetch_page(url: &str) -> Result<String, String> {
    get(url)
        .await?
        .text()
        .await
        .map_err(|e| format!("{url} could not be read: {e}"))
}

fn meta_description(html: &str) -> Option<String> {
    const TAG: &str = r#"<meta name="description" content=""#;
    let start = html.find(TAG)? + TAG.len();
    let content = &html[start..start + html[start..].find('"')?];
    let text = content
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    Some(text).filter(|text| !text.trim().is_empty())
}

/// A catalog skill's whole description, read from its `SKILL.md`. Asked only when the pointer
/// rests on a card, since it costs one of the download endpoint's 60 requests an hour.
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

/// The Agent Skills name rule, which `isSkillName` in `skills.ts` mirrors.
fn validate_name(name: &str) -> Result<(), String> {
    let valid = (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--");
    if valid {
        Ok(())
    } else {
        Err("A skill name is 1 to 64 lowercase letters, numbers and hyphens, with no hyphen at either end or two in a row".to_string())
    }
}

#[derive(Debug, Default, PartialEq)]
struct ParsedSkill {
    name: Option<String>,
    description: Option<String>,
}

/// `name` and `description` from `SKILL.md` frontmatter. The editor reads the rest itself, in
/// `skills.ts`.
///
/// ponytail: reads single-line scalars (plain, single- or double-quoted) and `>`/`|` blocks,
/// which is what skill frontmatter uses in practice. A YAML parser if anything stranger appears.
fn parse_skill_md(text: &str) -> ParsedSkill {
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return ParsedSkill::default();
    };
    let front = rest.find("\n---").map_or(rest, |end| &rest[..end]);
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exact_name_leads_the_search_whatever_its_installs() {
        let entry = |skill_id: &str, installs: u32| SkillCatalogEntry {
            id: format!("owner/repo/{skill_id}"),
            source: "owner/repo".to_string(),
            skill_id: skill_id.to_string(),
            name: skill_id.to_string(),
            installs: Some(installs),
        };
        let mut entries = vec![
            entry("ai-sdk", 60_000),
            entry("brag", 8_000),
            entry("code-review", 600_000),
        ];
        sort_search_results(&mut entries, "Brag");
        let order: Vec<&str> = entries.iter().map(|e| e.skill_id.as_str()).collect();
        assert_eq!(order, ["brag", "code-review", "ai-sdk"]);
    }

    #[test]
    fn a_page_summary_is_read_and_unescaped() {
        let html = r#"<head><meta name="description" content="Say &quot;/brag&quot;, let&#x27;s go &amp; &lt;ship&gt;…"/></head>"#;
        assert_eq!(
            meta_description(html).as_deref(),
            Some(r#"Say "/brag", let's go & <ship>…"#)
        );
        assert_eq!(meta_description("<head></head>"), None);
        assert_eq!(
            meta_description(r#"<meta name="description" content=""/>"#),
            None
        );
    }

    #[test]
    fn names_follow_the_agent_skills_rule() {
        assert!(validate_name("pdf-processing").is_ok());
        let long = "a".repeat(65);
        for bad in ["", "PDF", "-pdf", "pdf-", "pdf--x", "pdf_x", long.as_str()] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
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
        let single = parse_skill_md("---\nname: 'it''s'\n---\nbody");
        assert_eq!(single.name.as_deref(), Some("it's"));
    }

    #[test]
    fn a_file_without_frontmatter_has_no_name() {
        assert_eq!(parse_skill_md("just text"), ParsedSkill::default());
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
