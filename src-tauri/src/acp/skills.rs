//! The agent skills Maestro installs onto every connection it preflights.
//!
//! Bundled here rather than in maestro-server and sent over the wire, so that a skill edit ships
//! with the app instead of waiting for a maestro-server release.

use maestro_protocol::SkillFile;

const BUNDLED: &[(&str, &str)] = &[
    (
        "maestro-output/SKILL.md",
        include_str!("../../assets/skills/maestro-output/SKILL.md"),
    ),
    (
        "maestro-output/references/canvas.md",
        include_str!("../../assets/skills/maestro-output/references/canvas.md"),
    ),
    (
        "maestro-output/references/canvas-catalog.json",
        include_str!("../../assets/skills/maestro-output/references/canvas-catalog.json"),
    ),
    (
        "maestro-custom-agents/SKILL.md",
        include_str!("../../assets/skills/maestro-custom-agents/SKILL.md"),
    ),
];

pub fn bundled() -> Vec<SkillFile> {
    BUNDLED
        .iter()
        .map(|(path, contents)| SkillFile {
            path: (*path).to_string(),
            contents: (*contents).to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use maestro_protocol::AgentRegistryEntry;

    #[derive(serde::Deserialize)]
    struct CustomAgents {
        agents: Vec<AgentRegistryEntry>,
    }

    /// The `maestro-custom-agents` skill teaches the user's agent to hand-write
    /// `~/.maestro/custom-agents.json`, so its examples are the only specification of that file
    /// anyone reads. A registry schema change that leaves them behind produces entries
    /// maestro-server silently drops, on the user's machine, with nothing pointing back here.
    #[test]
    fn the_custom_agents_skill_documents_entries_that_still_parse() {
        let skill = super::BUNDLED
            .iter()
            .find_map(|(path, contents)| {
                (*path == "maestro-custom-agents/SKILL.md").then_some(*contents)
            })
            .expect("the custom agents skill is bundled");

        let examples: Vec<&str> = skill
            .split("```json")
            .skip(1)
            .filter_map(|rest| rest.split("```").next())
            .collect();
        assert_eq!(examples.len(), 2, "expected the schema and Ollama examples");

        for example in examples {
            let parsed: CustomAgents = serde_json::from_str(example)
                .unwrap_or_else(|error| panic!("example does not parse: {error}\n{example}"));
            for entry in &parsed.agents {
                assert!(!entry.id.is_empty());
                assert!(
                    entry.distribution.npx.is_some()
                        || entry.distribution.uvx.is_some()
                        || entry.distribution.binary.is_some(),
                    "example agent {:?} has no launch method",
                    entry.id
                );
            }
        }
    }
}
