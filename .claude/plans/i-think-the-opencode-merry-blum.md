# Debug: Add eprintln monitoring on Tauri (maestro) side for ACP messages

## Context

OpenCode ACP session connects and loads on remote, but user messages get no reply. Claude ACP and Codex ACP work fine — so maestro-server infrastructure is correct. Debug logs were added to maestro-server but no `/tmp/maestro-debug.log` appears, suggesting maestro-server stderr may not reach the expected file on remote. Need visibility on the Tauri side to see:
1. Is the prompt message being sent to maestro-server?
2. Is any response coming back from maestro-server?

## Changes

Add `eprintln!` at 3 points in Tauri code:

### 1. `src-tauri/src/ipc/acp_handlers.rs` — `send_prompt_impl` (line 325)

Add before the write call to confirm prompt leaves Tauri:

```rust
async fn send_prompt_impl(
    app_state: &Arc<AppState>,
    log_id: i32,
    content: serde_json::Value,
) -> Result<(), String> {
    eprintln!("[maestro] send_prompt_impl: log_id={log_id} content={content}");
    let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
        session_id: session_id_for(log_id),
        content,
    }));
    let result = crate::acp::write_to_acp_session(app_state, log_id, &msg).await;
    eprintln!("[maestro] send_prompt_impl result: {result:?}");
    result
}
```

### 2. `src-tauri/src/acp/manager.rs` — `handle_server_message` (line 854)

Add at top of function. Use compact variant for SessionUpdate (too verbose with full payload):

```rust
match &msg {
    MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd)) => {
        let update_type = upd.payload.get("sessionUpdate").and_then(|v| v.as_str()).unwrap_or("unknown");
        eprintln!("[maestro] handle_server_message: log_id={log_id} SessionUpdate({update_type})");
    }
    other => {
        eprintln!("[maestro] handle_server_message: log_id={log_id} msg={other:?}");
    }
}
```

`MaestroRpcMessage` has `Debug` derive — confirmed.

### 3. `src-tauri/src/acp/manager.rs` — `handle_shared_server_message` (line 1206)

Add at top:

```rust
eprintln!("[maestro] handle_shared_server_message: msg extract_session_log_id={:?}", extract_session_log_id(&msg));
```

## Pre-check

Need to verify `MaestroRpcMessage` has `Debug` impl. If not, use variant discriminant logging instead.

## Files to modify

- `src-tauri/src/ipc/acp_handlers.rs` (line ~325)
- `src-tauri/src/acp/manager.rs` (lines ~854, ~1206)

## Verification

1. `cargo check -p maestro` — compiles
2. `pnpm tauri:dev` — run dev mode, send message to OpenCode session
3. Check terminal output for eprintln traces showing message flow
