//! Reading the arguments of a Maestro MCP tool call. Nothing validates a tool's schema before its
//! arguments reach the daemon's gateway or the app's host tools, so both read them through these.
//!
//! Absent and null both mean "leave it"; a value of the wrong type is refused with the field's
//! name rather than coerced, because a silently coerced argument is the kind of thing nobody
//! notices.

use serde_json::Value;

pub fn string_argument(arguments: &Value, key: &str) -> Result<Option<String>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

pub fn bool_argument(arguments: &Value, key: &str) -> Result<Option<bool>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("{key} must be true or false")),
    }
}

pub fn string_list_argument(arguments: &Value, key: &str) -> Result<Option<Vec<String>>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| format!("{key} must be a list of strings")),
    }
}

/// A string argument that must be there and not blank, trimmed.
pub fn required_text(arguments: &Value, key: &str) -> Result<String, String> {
    string_argument(arguments, key)?
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{key} is required"))
}

/// One of a fixed set of names, if the agent supplied it.
pub fn enum_argument(
    arguments: &Value,
    key: &str,
    allowed: &[&str],
) -> Result<Option<String>, String> {
    let Some(name) = string_argument(arguments, key)? else {
        return Ok(None);
    };
    if !allowed.contains(&name.as_str()) {
        return Err(format!(
            "unknown {key} {name:?}, use one of {}",
            allowed.join(", ")
        ));
    }
    Ok(Some(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn absent_and_null_both_leave_a_field_alone() {
        let arguments = json!({ "title": null });
        assert_eq!(string_argument(&arguments, "title"), Ok(None));
        assert_eq!(string_argument(&arguments, "body"), Ok(None));
        assert_eq!(bool_argument(&arguments, "favorite"), Ok(None));
        assert_eq!(string_list_argument(&arguments, "tags"), Ok(None));
        assert_eq!(enum_argument(&arguments, "status", &["Done"]), Ok(None));
    }

    #[test]
    fn a_value_of_the_wrong_type_is_refused_by_name() {
        let arguments = json!({ "title": 1, "favorite": "yes", "tags": "a", "labels": ["a", 2] });
        assert_eq!(
            string_argument(&arguments, "title"),
            Err("title must be a string".to_string())
        );
        assert_eq!(
            bool_argument(&arguments, "favorite"),
            Err("favorite must be true or false".to_string())
        );
        assert_eq!(
            string_list_argument(&arguments, "tags"),
            Err("tags must be a list of strings".to_string())
        );
        // The gateway's `string_list` used to drop the 2 and keep "a".
        assert_eq!(
            string_list_argument(&arguments, "labels"),
            Err("labels must be a list of strings".to_string())
        );
    }

    #[test]
    fn required_text_is_trimmed_and_refuses_blank_or_mistyped_values() {
        assert_eq!(
            required_text(&json!({ "id": "  abc " }), "id"),
            Ok("abc".to_string())
        );
        assert_eq!(
            required_text(&json!({ "id": "  " }), "id"),
            Err("id is required".to_string())
        );
        assert_eq!(
            required_text(&json!({}), "id"),
            Err("id is required".to_string())
        );
        // The app's `required_str` called a number missing; it is a string of the wrong type.
        assert_eq!(
            required_text(&json!({ "id": 7 }), "id"),
            Err("id must be a string".to_string())
        );
    }

    #[test]
    fn an_enum_outside_its_set_is_refused_rather_than_guessed() {
        let allowed = ["Pipeline", "Loop"];
        assert_eq!(
            enum_argument(&json!({ "run_mode": "Loop" }), "run_mode", &allowed),
            Ok(Some("Loop".to_string()))
        );
        assert_eq!(
            enum_argument(&json!({ "run_mode": "Fast" }), "run_mode", &allowed),
            Err("unknown run_mode \"Fast\", use one of Pipeline, Loop".to_string())
        );
    }
}
