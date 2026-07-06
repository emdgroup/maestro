use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Arc;
use crate::connectivity::ssh::pty::SshWriteOp;

/// Handle to a remote interactive SSH PTY session.
///
/// `write_tx` sends input bytes or resize events to the remote PTY.
/// `history` buffers session output as a trimmed String (ANSI clear-screen aware, 512 KB cap).
/// `notify` fires whenever a new chunk is appended to `history`.
/// `process_ended` is set true when the remote process exits or the channel closes.
/// `total_drained` is the cumulative bytes ever removed from the **front** of `history` by the
/// 512 KB cap (not by clear-screen replacements). Readers subtract the delta from their byte
/// position on each iteration to stay correctly positioned after a drain.
/// `clear_screen_count` increments each time `append_to_history` completely replaces the buffer
/// due to a `\x1b[2J` sequence. Readers reset their byte position to 0 when this counter
/// advances — the old position is meaningless in the newly-replaced buffer, and failing to
/// reset causes partial escape sequences (e.g. `?2026l` without the leading `\x1b[`) to be
/// sent to the frontend as literal printable characters.
#[derive(Clone)]
pub struct SshPtyHandle {
    pub log_id: i32,
    pub write_tx: tokio::sync::mpsc::Sender<SshWriteOp>,
    pub history: Arc<tokio::sync::Mutex<String>>,
    pub notify: Arc<tokio::sync::Notify>,
    pub process_ended: Arc<AtomicBool>,
    pub total_drained: Arc<AtomicUsize>,
    pub clear_screen_count: Arc<AtomicUsize>,
}

/// Append a chunk to the SSH session history buffer with clear-screen trimming.
///
/// If the chunk contains `\x1b[2J` (ANSI clear-screen), all content before and
/// including the LAST occurrence is dropped — respecting the semantic meaning of
/// clear-screen. A 512 KB byte-cap fallback trims from the front to the nearest
/// `\r\n` boundary to prevent unbounded growth.
///
/// Returns `(drained_bytes, was_clear_screen)`:
/// - `drained_bytes`: bytes removed from the **front** of the buffer by the 512 KB cap
///   path (0 for clear-screen replacement and no-op appends). Callers add this to a
///   monotonic `total_drained` counter so readers can adjust their byte positions.
/// - `was_clear_screen`: true when the history buffer was completely replaced due to a
///   `\x1b[2J` sequence. Readers must reset their byte position to 0 when this is true,
///   regardless of whether the new history length is larger than the old position — the
///   old position is meaningless in the new (completely different) buffer.
pub(crate) fn append_to_history(history: &mut String, chunk: &str) -> (usize, bool) {
    if let Some(pos) = chunk.rfind("\x1b[2J") {
        // Clear-screen: replace buffer entirely — not a front-drain.
        // Prepend \x1b[H (cursor home) so readers always start at the top-left corner
        // when replaying. The real `clear` command sends \x1b[H\x1b[2J but we trim
        // everything before the last \x1b[2J, losing the \x1b[H. Restoring it here
        // prevents new output from appearing at the old cursor position after a clear.
        history.clear();
        history.push_str("\x1b[H");
        history.push_str(&chunk[pos..]);
        (0, true)
    } else {
        history.push_str(chunk);
        const MAX_BYTES: usize = 512 * 1024;
        if history.len() > MAX_BYTES {
            let trim_to = history.len() - MAX_BYTES;
            // Round up to a valid char boundary
            let trim_to = (trim_to..history.len())
                .find(|&i| history.is_char_boundary(i))
                .unwrap_or(trim_to);
            if let Some(nl) = history[trim_to..].find("\r\n") {
                let actual = trim_to + nl + 2;
                history.drain(..actual);
                (actual, false)
            } else {
                history.drain(..trim_to);
                (trim_to, false)
            }
        } else {
            (0, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::append_to_history;

    #[test]
    fn test_append_to_history_clear_screen_mid_chunk() {
        let mut hist = String::from("old content");
        append_to_history(&mut hist, "prefix\x1b[2Jfresh");
        assert_eq!(hist, "\x1b[H\x1b[2Jfresh");
    }

    #[test]
    fn test_append_to_history_clear_screen_at_end() {
        let mut hist = String::from("old content");
        append_to_history(&mut hist, "some\x1b[2J");
        assert_eq!(hist, "\x1b[H\x1b[2J");
    }

    #[test]
    fn test_append_to_history_no_clear_under_cap() {
        let mut hist = String::from("hello ");
        append_to_history(&mut hist, "world");
        assert_eq!(hist, "hello world");
    }

    #[test]
    fn test_append_to_history_byte_cap_trim() {
        let mut hist = String::new();
        // Fill with lines totaling > 512 KB
        for i in 0..60000 {
            hist.push_str(&format!("line {}\r\n", i));
        }
        let before_len = hist.len();
        assert!(before_len > 512 * 1024);
        append_to_history(&mut hist, "final chunk");
        assert!(hist.len() <= 512 * 1024 + 20); // some tolerance for the final chunk
        assert!(hist.ends_with("final chunk"));
        // Should have trimmed at a \r\n boundary
        assert!(!hist.starts_with("line 0\r\n"));
    }

    #[test]
    fn test_append_to_history_utf8_boundary_safety() {
        let mut hist = String::new();
        // Fill near cap with multi-byte chars (each e-acute is 2 bytes)
        let repeated = "\u{00e9}".repeat(256 * 1024); // 512 KB of 2-byte chars
        hist.push_str(&repeated);
        // Append more to trigger trim
        append_to_history(&mut hist, &"\u{00e9}".repeat(1024));
        // Should not panic — that's the test
        assert!(hist.len() <= 512 * 1024 + 4096);
    }

    #[test]
    fn test_append_to_history_multiple_clear_screens() {
        let mut hist = String::from("old");
        append_to_history(&mut hist, "a\x1b[2Jb\x1b[2Jc");
        // rfind picks the LAST \x1b[2J; \x1b[H is prepended for correct cursor home on replay
        assert_eq!(hist, "\x1b[H\x1b[2Jc");
    }
}
