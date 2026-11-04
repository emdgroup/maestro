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
