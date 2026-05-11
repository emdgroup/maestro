# Fix: Cancel button doesn't work for remote agent sessions

## Context

Cancel/stop button in agent sessions:
1. Clicking cancel does nothing — agent keeps running
2. Button stays in "processing" state after agent finishes answering

Issue is remote-only regression introduced by the transport unification refactor (commit `5a98a76`).

## Root Cause

**File:** `src-tauri/src/acp/manager.rs` — `AcpReadSource::Remote::next_message()` (line 169)

```rust
AcpReadSource::Remote { read_half, msg_buf } => loop {
    match read_half.wait().await {          // ← BUG: always waits for new SSH data
        Some(ChannelMsg::Data { data }) => {
            msg_buf.extend_from_slice(&data);
            if let Some(msg) = try_parse_acp_frame(msg_buf) {
                return Some(msg);
            }
        }
        // ...
    }
},
```

The `msg_buf` persists between calls (leftover bytes from previous reads). When multiple messages arrive in a single SSH data chunk (common — TCP coalesces small writes), only the first message is parsed and returned. On the NEXT call to `next_message()`, the code goes straight to `read_half.wait().await` **without checking if `msg_buf` already contains a complete message**.

Result: `TurnEnded` (and other messages) get stuck in `msg_buf` until the next SSH packet arrives. Since `TurnEnded` is typically the LAST message in a turn, no new packet comes → message is permanently stuck.

This explains both symptoms:
- **Cancel does nothing**: Agent receives CancelNotification, responds with TurnEnded, but TurnEnded arrives in same chunk as last streaming update → stuck in buffer
- **Button stays active after finish**: TurnEnded arrives bundled with final content chunk → stuck in buffer

The local path (`AcpReadSource::Local`) uses `BufReader` + `read_message()` which handles framing correctly (reads exactly one newline-delimited message per call). The remote path lost this property during refactoring.

## Fix

**File:** `src-tauri/src/acp/manager.rs` — line 169

Check `msg_buf` for a complete message BEFORE blocking on `read_half.wait()`:

```rust
AcpReadSource::Remote { read_half, msg_buf } => loop {
    if let Some(msg) = try_parse_acp_frame(msg_buf) {
        return Some(msg);
    }
    match read_half.wait().await {
        Some(ChannelMsg::Data { data }) => {
            msg_buf.extend_from_slice(&data);
            if let Some(msg) = try_parse_acp_frame(msg_buf) {
                return Some(msg);
            }
        }
        Some(ChannelMsg::ExtendedData { .. })
        | Some(ChannelMsg::WindowAdjusted { .. }) => {}
        Some(ChannelMsg::Eof)
        | Some(ChannelMsg::Close)
        | Some(ChannelMsg::ExitStatus { .. })
        | None => return None,
        _ => {}
    }
},
```

Single check at loop top drains any buffered message before blocking on the channel. All messages in a multi-message chunk are now returned one per `next_message()` call without requiring new network data.

## Verification

1. `cd src-tauri && cargo check` — compiles
2. Manual test with remote connection: send prompt → agent responds → button resets immediately
3. Manual test with remote connection: send prompt → click cancel mid-response → agent stops, button resets
4. Verify local connections still work (no behavioral change — local path untouched)
