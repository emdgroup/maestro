//! What a skill in a connection's library may be called. The app checks a name before it asks for
//! a skill, and the daemon before it writes or removes one under `~/.maestro/skill-library/`.

/// The Agent Skills name rule, which `isSkillName` in `skills.ts` mirrors: 1 to 64 lowercase
/// letters, digits and hyphens, with no hyphen at either end or two in a row. Every new skill is
/// held to it.
pub fn validate_skill_name(name: &str) -> Result<(), String> {
    if is_library_name(name)
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
    {
        Ok(())
    } else {
        Err("A skill name is 1 to 64 lowercase letters, numbers and hyphens, with no hyphen at either end or two in a row".to_string())
    }
}

/// Whether `name` can be a skill already in the library: 1 to 64 lowercase letters, digits and
/// hyphens, which is also what keeps it safe to use as a directory name.
///
/// Looser than [`validate_skill_name`] on purpose. The app accepted names such as `-a--b-` until
/// the hyphen rule was added, and the daemon wrote them to disk, so a skill already there must stay
/// possible to switch per agent and to delete.
pub fn is_library_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_names_follow_the_agent_skills_rule() {
        assert!(validate_skill_name("pdf-processing").is_ok());
        assert!(validate_skill_name("pdf-tools-2").is_ok());
        let long = "a".repeat(65);
        for bad in [
            "",
            "PDF",
            "-pdf",
            "pdf-",
            "pdf--x",
            "pdf_x",
            "a/b",
            "..",
            long.as_str(),
        ] {
            assert!(validate_skill_name(bad).is_err(), "{bad}");
        }
    }

    /// The two copies disagreed here: the daemon's accepted these, the app's refused them. A name
    /// already in the library stays manageable; it just cannot be created any more.
    #[test]
    fn a_name_written_before_the_hyphen_rule_is_still_a_library_name() {
        for name in ["-a--b-", "pdf-", "-pdf", "pdf--x"] {
            assert!(validate_skill_name(name).is_err(), "{name}");
            assert!(is_library_name(name), "{name}");
        }
        for bad in ["", "PDF", "a/b", "..", "a_b"] {
            assert!(!is_library_name(bad), "{bad}");
        }
        assert!(!is_library_name(&"x".repeat(65)));
    }
}
