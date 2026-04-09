---
status: fixing
trigger: "When resizing the window during an agent session, garbled escape sequences are written to the terminal output: ?2026l?2026lm\n9m \nm\nm"
created: 2026-04-09T00:00:00Z
updated: 2026-04-09T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED — SSH history reader pos not reset on clear-screen replacement when new history >= old pos
test: Code trace confirmed — when append_to_history does clear-screen replacement, reader pos can be within bounds of new history but pointing mid-sequence
expecting: Fix adds clear_screen_count AtomicUsize to track replacements; reader resets to 0 when count changes
next_action: Implement fix in src-tauri/src/ssh/session.rs

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Window resize is handled silently — terminal reflows, no visible output
actual: Raw escape sequence characters appear in the terminal output: "?2026l?2026lm\n9m \nm\nm"
errors: No crash, just garbage text written to the PTY output/display
reproduction: Open an agent session → enlarge the window size → garbled chars appear
started: Unknown if it ever worked; likely a PTY resize handling bug

## Eliminated

- hypothesis: ESC bytes stripped in Rust PTY output pipeline
  evidence: No code path strips escape bytes; String::from_utf8_lossy preserves \x1b (valid ASCII); no sanitization found
  timestamp: 2026-04-09

- hypothesis: Tauri IPC channel corrupts \x1b byte during JSON serialization
  evidence: JSON round-trip test confirmed \x1b → \u001b → \x1b correctly preserved
  timestamp: 2026-04-09

- hypothesis: xterm.js doesn't handle \x1b[?2026l correctly
  evidence: xterm.js 6.0.0 source has explicit case 2026 in resetModePrivate setting synchronizedOutput=false
  timestamp: 2026-04-09

- hypothesis: UTF-8 boundary split corrupts ESC byte
  evidence: \x1b (0x1B) is valid ASCII, never replaced by from_utf8_lossy; cannot appear as part of multi-byte sequence
  timestamp: 2026-04-09

## Evidence

- timestamp: 2026-04-09
  checked: Actual PTY bytes from claude CLI on resize via Python test
  found: resize response starts with \x1b[?2026h\x1b[2D\x1b[4B\x1b[2J at bytes 0-19, ends with \x1b[?2026l at byte 1305, total 1313 bytes. One \x1b[2J occurrence.
  implication: append_to_history rfind("\x1b[2J") finds position 16; history replaced with "\x1b[H" + chunk[16..] = 1300 bytes total

- timestamp: 2026-04-09
  checked: Initial claude startup output byte counts
  found: Initial output = 1299 bytes, 0x\x1b[2J], 2x\x1b[?2026l], 2x\x1b[?2026h]
  implication: Initial history = 1299 bytes (no clear-screen in startup). append_to_history just appends.

- timestamp: 2026-04-09
  checked: Reader position after initial history is fully sent
  found: pos = 1299 (== old hist.len())
  implication: After first resize, new hist.len() = 1300. pos (1299) < hist.len() (1300). Code does NOT reset pos to 0 — it sends hist[1299..1300] = last 1 byte.

- timestamp: 2026-04-09
  checked: What byte is at position 1299 of the new history?
  found: New history = "\x1b[H]" (3 bytes) + chunk[16..1313] (1297 bytes). hist[1299] = chunk[1299-3+16] = chunk[1312] = last byte of resize response = 'l' (from \x1b[?2026l])
  implication: Reader sends just "l" to xterm.js when old pos = 1299 and new hist = 1300 bytes

- timestamp: 2026-04-09
  checked: General case — when does ?2026l appear as visible text?
  found: When old pos falls 1, 2, 3, or 4 bytes into \x1b[?2026l] in the new history, the reader sends [?2026l], ?2026l, 2026l, 026l as literal characters
  implication: \x1b[?2026l] is 8 bytes. If pos lands at byte +1 (\x1b is at 0), reader sends [?2026l] — xterm.js prints [?2026l literal. If +2, sends ?2026l. User reports exactly ?2026l — pos must land 2 bytes into the sequence (after \x1b[).

- timestamp: 2026-04-09
  checked: Why does ?2026l appear TWICE?
  found: Two consecutive resize events (e.g., initial RAF fit + ResizeObserver fit on mount) both trigger this pattern with similar history lengths, causing the same tail bytes to be sent twice
  implication: Confirmed — two onResize events fire on mount (once from RAF fitAddon.fit(), once from ResizeObserver)

## Resolution

root_cause: append_to_history in session.rs does a full clear-screen replacement when history contains \x1b[2J]. The reader's position is only reset to 0 when pos > hist.len(). When the new history is LONGER than the old pos (common when both are similar sizes ~1300 bytes), the reader reads from hist[old_pos..] which is the TAIL of the completely new history, potentially mid-way through an escape sequence like \x1b[?2026l]. The \x1b and [ bytes are before pos and thus never sent; xterm.js receives ?2026l as printable characters.

fix: Add a clear_screen_count: Arc<AtomicUsize> to SshPtyHandle and PtySession data flow; increment it in append_to_history on each clear-screen replacement; reader tracks last_clear_count and resets pos to 0 when count changes — ensuring full history replay after every clear-screen replacement regardless of size relationship.
verification:
files_changed: [src-tauri/src/ssh/session.rs]
