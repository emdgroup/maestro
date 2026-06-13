use std::io::Read;

use serde_json::Value;

pub fn run() -> i32 {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("ERROR: Failed to read stdin");
        return 1;
    }

    let instance: Value = match serde_json::from_str(input.trim()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("ERROR: Invalid JSON — {e}");
            return 1;
        }
    };

    let catalog_path = std::path::Path::new(".maestro/canvas-catalog.json");
    let catalog_str = match std::fs::read_to_string(catalog_path) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("ERROR: Cannot read .maestro/canvas-catalog.json");
            return 1;
        }
    };

    let catalog: Value = match serde_json::from_str(&catalog_str) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("ERROR: Corrupt canvas-catalog.json — {e}");
            return 1;
        }
    };

    let session_update = match instance.get("sessionUpdate").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            eprintln!("ERROR: Missing 'sessionUpdate' field — must be canvas_create, canvas_update, or canvas_data");
            return 1;
        }
    };

    let empty_vec = vec![];
    let messages = catalog
        .pointer("/protocol/messages")
        .and_then(|m| m.as_array())
        .unwrap_or(&empty_vec);

    let message = messages
        .iter()
        .find(|m| m.get("type").and_then(|t| t.as_str()) == Some(session_update.as_str()));

    let message = match message {
        Some(m) => m,
        None => {
            let known: Vec<&str> = messages
                .iter()
                .filter_map(|m| m.get("type").and_then(|t| t.as_str()))
                .collect();
            eprintln!(
                "ERROR: Unknown sessionUpdate '{}' — must be one of: {}",
                session_update,
                known.join(", ")
            );
            return 1;
        }
    };

    let schema_val = match message.get("jsonSchema") {
        Some(s) => s.clone(),
        None => {
            eprintln!(
                "ERROR: No jsonSchema defined for '{}' in canvas-catalog.json — catalog may be outdated",
                session_update
            );
            return 1;
        }
    };

    let validator = match jsonschema::validator_for(&schema_val) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("ERROR: Cannot compile catalog schema — {e}");
            return 1;
        }
    };

    let mut failed = false;
    for error in validator.iter_errors(&instance) {
        eprintln!("ERROR: {error}");
        failed = true;
    }

    if session_update == "canvas_update" {
        if let Some(comps) = instance.get("components").and_then(|c| c.as_array()) {
            for comp in comps {
                if comp.get("component").and_then(|c| c.as_str()) == Some("Html") {
                    if let Some(srcdoc) = comp.get("srcdoc").and_then(|s| s.as_str()) {
                        if srcdoc.contains('"') {
                            eprintln!("ERROR: Html srcdoc contains double-quote characters — use single quotes for all HTML attributes and JS strings");
                            failed = true;
                        }
                        if srcdoc.contains('\\') {
                            eprintln!("ERROR: Html srcdoc contains backslashes — avoid backslash escapes in JS; use DOM API or character alternatives");
                            failed = true;
                        }
                    }
                }
            }
        }
    }

    if failed {
        return 1;
    }
    eprintln!("OK: Canvas fence is valid");
    0
}
