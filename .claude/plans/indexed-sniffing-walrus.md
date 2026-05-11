# Simplify: Remaining Fixes

## Context

Previous `/simplify` review found issues. eprintln removal was a false positive — user wants those for debugging maestro-server JSON exchange. Restore them and proceed with valid fixes.

## Fixes

### 0. Restore eprintln! calls — `src-tauri/src/acp/manager.rs`

**Why:** User intentionally logs all JSON sent/received with maestro-server for debugging. Not accidental debug leftovers.

**Restore in `serialize_message` (line 163, outbound shared-server path):**
```rust
pub(crate) fn serialize_message(msg: &MaestroRpcMessage) -> Result<Vec<u8>, String> {
    let json_bytes = serde_json::to_vec(msg)
        .map_err(|e| format!("Failed to serialize ACP message: {}", e))?;
    eprintln!("[ACP →] {}", String::from_utf8_lossy(&json_bytes));
    let len = json_bytes.len() as u32;
    ...
```

**Restore in `AcpReadSource::next_message` (inbound, both Local and Remote arms):**
```rust
AcpReadSource::Local { reader } => {
    let msg = read_message(reader).await.ok();
    if let Some(ref m) = msg {
        if let Ok(json) = serde_json::to_string(m) {
            eprintln!("[ACP ←] {}", json);
        }
    }
    msg
}
AcpReadSource::Remote { read_half, msg_buf } => loop {
    if let Some(msg) = try_parse_acp_frame(msg_buf) {
        if let Ok(json) = serde_json::to_string(&msg) {
            eprintln!("[ACP ←] {}", json);
        }
        return Some(msg);
    }
    match read_half.wait().await {
        Some(ChannelMsg::Data { data }) => {
            msg_buf.extend_from_slice(&data);
            if let Some(msg) = try_parse_acp_frame(msg_buf) {
                if let Ok(json) = serde_json::to_string(&msg) {
                    eprintln!("[ACP ←] {}", json);
                }
                return Some(msg);
            }
        }
        ...
```

**Restore in `write_to_acp_session_raw` (outbound cold-path):**
```rust
async fn write_to_acp_session_raw(
    stdin_writer: &mut BufWriter<ChildStdin>,
    msg: &MaestroRpcMessage,
) -> Result<(), String> {
    if let Ok(json) = serde_json::to_string(msg) {
        eprintln!("[ACP →] {}", json);
    }
    write_message(stdin_writer, msg)
    ...
```

No double-logging: each message goes through exactly one of `serialize_message` OR `write_to_acp_session_raw`, never both.

### 1. Fix `check_tools` sequential join — `maestro-server/src/main.rs`

**Problem:** `tokio::spawn` creates parallel tasks but the for-loop `handle.await` joins them sequentially. A slow tool (e.g. `npx`) blocks collection of faster results.

**Fix:** Replace the for-loop with `futures::future::join_all(handles).await`. `futures = "0.3"` already in Cargo.toml. This preserves original ordering and joins concurrently.

```rust
// Before:
let mut results = Vec::with_capacity(handles.len());
for handle in handles {
    if let Ok(result) = handle.await {
        results.push(result);
    }
}
results

// After:
futures::future::join_all(handles)
    .await
    .into_iter()
    .filter_map(Result::ok)
    .collect()
```

### 2. Remove comment — `src/components/project-picker/ConnectionHeader.tsx:106`

Delete: `// Badge only shows when user has explicitly ignored warnings (not before they've decided)`

The code (`ignoredWarnings ? ... : []`) is self-explanatory.

### 3. Add `startPreflight` guard — `src/contexts/ConnectionContext.tsx`

**Problem:** `startPreflight` re-runs unconditionally on every connection click, even if already checking or already passed for same connection.

**Fix:** Add early return at top of `startPreflight`:
```tsx
if (preflightStatus === "checking") return;
```

Don't guard against re-running for a passed connection — user might reconnect. Only guard against double-firing while already in flight.

### 4. Replace `ignoredWarnings` with status variant — Multiple files

**Problem:** `ignoredWarnings: boolean` + `preflightStatus === "failed"` creates redundant state. The real states are: idle, checking, passed, failed (blocking), failed (ignored).

**Fix:** Extend `PreflightStatus` to `"idle" | "checking" | "passed" | "failed" | "failed-ignored"`. Remove `ignoredWarnings` state and `ignoredWarnings` from context interface. Keep `ignoreWarnings()` method — it now sets status to `"failed-ignored"`.

**Files:**
- `src/contexts/ConnectionContext.tsx` — change type, remove `ignoredWarnings` state, update `ignoreWarnings` to set `"failed-ignored"`, update `resetPreflight`, remove from context value
- `src/components/project-picker/ProjectList.tsx` — `showProjects = status === "passed" || status === "failed-ignored"`, `showFailureModal = status === "failed"`
- `src/components/project-picker/ConnectionHeader.tsx` — replace `ignoredWarnings` check with `preflightStatus === "failed-ignored"`
- `src/components/project-picker/__tests__/ProjectList.test.tsx` — remove `ignoredWarnings: false` from mock
- `src/components/project-picker/__tests__/ProjectPicker.test.tsx` — remove `ignoredWarnings: false` from all 5 mock instances
- `src/types/bindings.ts` — no change needed (PreflightStatus is frontend-only)

### 5. Fix triple ternary — `src/components/project-picker/ProjectList.tsx`

**Problem:** Third branch renders empty `<div className="h-full" />` placeholder just to reserve space for the absolutely-positioned modal. This makes the ternary confusing.

**Fix:** The empty div is needed for layout (the modal is `absolute inset-0`). But the ternary can be flattened. Render the projects list conditionally, and the checking spinner conditionally, with no else chain:

```tsx
{isChecking && (
  <div className="..."><Loader2 .../><span>...</span></div>
)}
{showProjects && (
  recentProjects.length === 0 ? <p>No recent projects</p> : <ul>...</ul>
)}
```

The `showFailureModal` empty div is unnecessary — the modal overlay covers the container anyway. Remove it.

## Verification

```bash
cd src-tauri && cargo check         # Rust compiles
pnpm lint                           # No lint errors
pnpm test                           # Unit tests pass (updated mocks)
pnpm tauri:dev                      # App launches, preflight works
```
