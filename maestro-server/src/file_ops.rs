use ignore::WalkBuilder;
use maestro_protocol::{FileReadRequest, FileSearchRequest};

/// Truncate `buf` from the beginning to at most `limit` bytes, on a UTF-8 char boundary.
pub(crate) fn truncate_buf(buf: &mut String, limit: usize) {
    if buf.len() > limit {
        let excess = buf.len() - limit;
        let safe_pos = buf
            .char_indices()
            .map(|(i, _)| i)
            .find(|&i| i >= excess)
            .unwrap_or(buf.len());
        *buf = buf[safe_pos..].to_string();
    }
}

fn fuzzy_score(path: &str, query_lower: &str) -> i64 {
    if query_lower.is_empty() {
        let depth = path.chars().filter(|c| *c == '/').count();
        return 1000 - depth as i64;
    }

    let path_lower = path.to_lowercase();
    let basename_lower = path_lower.rsplit('/').next().unwrap_or(&path_lower);

    let mut score: i64 = 0;

    if basename_lower == query_lower {
        score += 100;
    } else if basename_lower.starts_with(query_lower) {
        score += 50;
    } else if basename_lower.contains(query_lower) {
        score += 30;
    } else if path_lower.contains(query_lower) {
        score += 20;
    } else {
        let mut chars = path_lower.chars().peekable();
        let mut matched = 0i64;
        for qc in query_lower.chars() {
            let mut found = false;
            while let Some(&hc) = chars.peek() {
                chars.next();
                if hc == qc {
                    matched += 1;
                    found = true;
                    break;
                }
            }
            if !found {
                return 0;
            }
        }
        score += matched;
    }

    score -= (path.len() as i64) / 10;
    score.max(1)
}

pub(crate) fn handle_file_search(req: FileSearchRequest) -> Result<Vec<String>, String> {
    let limit = req.limit.unwrap_or(50) as usize;
    let root = std::path::Path::new(&req.cwd);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", req.cwd));
    }

    let query_lower = req.query.to_lowercase();
    let mut results: Vec<(i64, String)> = Vec::new();

    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(20))
        .build();

    for entry in walker.flatten() {
        let file_type = entry.file_type();
        if !file_type.map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let rel_path = match entry.path().strip_prefix(root) {
            Ok(p) => p.to_string_lossy().into_owned(),
            Err(_) => continue,
        };

        let score = fuzzy_score(&rel_path, &query_lower);
        if score > 0 {
            results.push((score, rel_path));
        }
    }

    results.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    results.truncate(limit);
    Ok(results.into_iter().map(|(_, p)| p).collect())
}

pub(crate) async fn handle_file_read(req: &FileReadRequest) -> Result<String, String> {
    let rel = std::path::Path::new(&req.relative_path);
    if rel.is_absolute() {
        return Err("relative_path must not be absolute".to_string());
    }
    for component in rel.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err("relative_path must not contain '..' segments".to_string());
        }
    }

    let full_path = std::path::Path::new(&req.cwd).join(rel);
    let canonical = full_path
        .canonicalize()
        .map_err(|e| format!("File not found: {e}"))?;
    let canonical_root = std::path::Path::new(&req.cwd)
        .canonicalize()
        .map_err(|e| format!("Invalid cwd: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Path escapes project root".to_string());
    }

    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|e| format!("Cannot stat file: {e}"))?;
    if metadata.len() > 1_048_576 {
        return Err("File too large (>1MB)".to_string());
    }

    tokio::fs::read_to_string(&canonical)
        .await
        .map_err(|e| format!("Cannot read file: {e}"))
}
