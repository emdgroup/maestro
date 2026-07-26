use ignore::WalkBuilder;
use maestro_protocol::{FileReadRequest, FileSearchRequest};
use std::collections::VecDeque;

/// Retained terminal output, held as discrete lines with a running byte total.
///
/// Lines rather than one `String` because trimming must stay cheap: an agent may request a
/// byte cap and then produce far more output than that, so the cap is hit once and then on
/// every subsequent line. Popping whole lines off the front is O(1) amortized — each line is
/// pushed once and popped once. Trimming a single `String` in place is not: it costs a rescan
/// and a copy of the whole retained buffer per line, which is quadratic in the total output.
pub(crate) struct OutputBuffer {
    lines: VecDeque<String>,
    bytes: usize,
}

impl OutputBuffer {
    pub(crate) fn new() -> Self {
        Self { lines: VecDeque::new(), bytes: 0 }
    }

    /// Append `chunk`, dropping whole lines from the front while `limit` is exceeded.
    /// Returns true if anything was dropped, so the caller can set the `truncated` flag.
    pub(crate) fn push(&mut self, chunk: String, limit: Option<usize>) -> bool {
        self.bytes += chunk.len();
        self.lines.push_back(chunk);

        let Some(limit) = limit else {
            return false;
        };

        let mut truncated = false;
        while self.bytes > limit && self.lines.len() > 1 {
            if let Some(front) = self.lines.pop_front() {
                self.bytes -= front.len();
                truncated = true;
            }
        }

        // A single line longer than the whole cap still has to be trimmed, or the cap would
        // be a suggestion. Only reachable for one oversized line, so the in-place cost is fine.
        if self.bytes > limit {
            if let Some(last) = self.lines.back_mut() {
                let excess = last.len() - limit;
                let mut split = excess;
                while split < last.len() && !last.is_char_boundary(split) {
                    split += 1;
                }
                last.drain(..split);
                self.bytes = last.len();
                truncated = true;
            }
        }

        truncated
    }

    /// The retained output as a single string, oldest line first.
    pub(crate) fn contents(&self) -> String {
        let mut out = String::with_capacity(self.bytes);
        for line in &self.lines {
            out.push_str(line);
        }
        out
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

#[cfg(test)]
mod tests {
    use super::OutputBuffer;

    #[test]
    fn no_limit_retains_everything() {
        let mut buf = OutputBuffer::new();
        for i in 0..1000 {
            assert!(!buf.push(format!("line {i}\n"), None));
        }
        assert!(buf.contents().starts_with("line 0\n"));
        assert!(buf.contents().ends_with("line 999\n"));
    }

    #[test]
    fn under_limit_is_not_truncated() {
        let mut buf = OutputBuffer::new();
        assert!(!buf.push("hello\n".to_string(), Some(100)));
        assert!(!buf.push("world\n".to_string(), Some(100)));
        assert_eq!(buf.contents(), "hello\nworld\n");
    }

    #[test]
    fn drops_oldest_lines_and_reports_truncation() {
        let mut buf = OutputBuffer::new();
        // Each line is 8 bytes ("line N\n" is 7 for single digits); cap at 30 bytes.
        let mut ever_truncated = false;
        for i in 0..20 {
            ever_truncated |= buf.push(format!("line {i}\n"), Some(30));
        }
        assert!(ever_truncated);
        let contents = buf.contents();
        assert!(contents.len() <= 30, "retained {} bytes", contents.len());
        assert!(contents.ends_with("line 19\n"));
        assert!(!contents.contains("line 0\n"));
    }

    #[test]
    fn single_line_longer_than_cap_is_trimmed_to_cap() {
        let mut buf = OutputBuffer::new();
        assert!(buf.push("x".repeat(500), Some(100)));
        assert_eq!(buf.contents().len(), 100);
    }

    #[test]
    fn trimming_an_oversized_line_respects_char_boundaries() {
        let mut buf = OutputBuffer::new();
        // 2-byte chars: a cap that lands mid-char must round forward, not panic or split.
        buf.push("é".repeat(200), Some(101));
        let contents = buf.contents();
        assert!(contents.len() <= 101);
        assert!(contents.chars().all(|c| c == 'é'));
    }

    #[test]
    fn newest_line_survives_even_when_cap_is_tiny() {
        let mut buf = OutputBuffer::new();
        buf.push("old\n".to_string(), Some(4));
        buf.push("new\n".to_string(), Some(4));
        assert_eq!(buf.contents(), "new\n");
    }
}
