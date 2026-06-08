# Fix: Claude agent `session/set_model` method not found

## Context

Claude Code's ACP implementation doesn't support the unstable `session/set_model` method (JSON-RPC `-32601`). Other agents (Codex, Gemini CLI, etc.) do support it. Maestro sends `session/set_model` unconditionally without fallback, so model switching breaks exclusively for Claude.

Per ACP spec: `session/set_config_option` is the stable, preferred method. `session/set_model` and `session/set_mode` are legacy and will be removed. Maestro should use `set_config_option` primarily, falling back to legacy methods only for agents that don't support config options.

## Fix

**File:** `maestro-server/src/session/command_loop.rs`

Change both `SetModel` and `SetMode` handlers to:
1. Try `SetSessionConfigOptionRequest` first (stable ACP method)
2. On `MethodNotFound`, fall back to legacy `SetSessionModelRequest` / `SetSessionModeRequest`
3. Still emit `SetModelOk` / `SetModeOk` responses regardless of which method succeeded (keeps Tauri response handling and `current_model_id` tracking intact)

### SetModel handler (lines 235-279):

```rust
SessionCommand::SetModel(model_id) => {
    let result = cx
        .send_request(SetSessionConfigOptionRequest::new(
            session_id.clone(),
            SessionConfigId::new("model".to_string()),
            SessionConfigValueId::new(model_id.clone()),
        ))
        .block_task()
        .await;
    let msg = match result {
        Ok(_) => MaestroRpcMessage::Response(ServerResponse::SetModelOk(
            SetModelOkResponse {
                session_id: maestro_sid.clone(),
                model_id,
            },
        )),
        Err(e) if e.code == acp::ErrorCode::MethodNotFound => {
            // Agent doesn't support set_config_option; fall back to legacy set_model
            let fallback = cx
                .send_request(SetSessionModelRequest::new(
                    session_id.clone(),
                    model_id.clone(),
                ))
                .block_task()
                .await;
            match fallback {
                Ok(_) => MaestroRpcMessage::Response(ServerResponse::SetModelOk(
                    SetModelOkResponse {
                        session_id: maestro_sid.clone(),
                        model_id,
                    },
                )),
                Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(
                    ErrorResponse {
                        message: format!("SetModel failed: {}", e),
                    },
                )),
            }
        }
        Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
            message: format!("SetModel failed: {}", e),
        })),
    };
    let _ = send_response(&so, &msg).await;
}
```

### SetMode handler (lines 281-301) — same pattern:

```rust
SessionCommand::SetMode(mode_id) => {
    let result = cx
        .send_request(SetSessionConfigOptionRequest::new(
            session_id.clone(),
            SessionConfigId::new("mode".to_string()),
            SessionConfigValueId::new(mode_id.clone()),
        ))
        .block_task()
        .await;
    let msg = match result {
        Ok(_) => MaestroRpcMessage::Response(ServerResponse::SetModeOk(
            SetModeOkResponse {
                session_id: maestro_sid.clone(),
                mode_id,
            },
        )),
        Err(e) if e.code == acp::ErrorCode::MethodNotFound => {
            let fallback = cx
                .send_request(SetSessionModeRequest::new(
                    session_id.clone(),
                    mode_id.clone(),
                ))
                .block_task()
                .await;
            match fallback {
                Ok(_) => MaestroRpcMessage::Response(ServerResponse::SetModeOk(
                    SetModeOkResponse {
                        session_id: maestro_sid.clone(),
                        mode_id,
                    },
                )),
                Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(
                    ErrorResponse {
                        message: format!("SetMode failed: {}", e),
                    },
                )),
            }
        }
        Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
            message: format!("SetMode failed: {}", e),
        })),
    };
    let _ = send_response(&so, &msg).await;
}
```

No import changes needed — `acp::ErrorCode` already accessible via `use agent_client_protocol as acp;`.

## Why only command_loop.rs

- Tauri `prompt_handlers.rs` and `maestro-protocol` message types stay unchanged — they still route "model" → `SetModel` command
- `manager.rs` response handling stays unchanged — still receives `SetModelOk`/`SetModeOk`
- `current_model_id`/`current_mode_id` tracking in manager still works
- Frontend event listeners (`model-changed`, `mode-changed`) still fire correctly

## Verification

1. `cargo check -p maestro-server` — confirms compilation
2. Start app, Claude agent session → change model → should succeed
3. Other agents (Codex, etc.) → change model → should succeed (config_option works, or falls back to legacy)
4. Change mode for Claude → should succeed via same pattern
