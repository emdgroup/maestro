# Develop Elicitation Handler

## Context

The elicitation handler in maestro-server currently operates as a raw string-match in a catch-all `UntypedMessage` handler. It doesn't declare elicitation capabilities during ACP handshake (agents send elicitation requests blind), passes raw JSON through the protocol bridge, and performs zero validation. This makes it fragile and invisible to agents that check capabilities before using elicitation.

The `agent-client-protocol` 0.11.1 doesn't pass through `unstable_elicitation`, so we can't register a typed `on_receive_request` handler. But adding `agent-client-protocol-schema` directly with the feature gives us typed structs for validation and the `ClientCapabilities::elicitation()` builder method.

## Changes

### 1. Add schema dependency (`maestro-server/Cargo.toml`)

Add direct dependency on the schema crate with the elicitation feature:
```toml
agent-client-protocol-schema = { version = "=0.12.0", features = ["unstable_elicitation"] }
```

Cargo unifies features — this enables `unstable_elicitation` on the same schema crate instance already in the dep tree. The `ClientCapabilities` struct (re-exported by `agent-client-protocol`) gains its `elicitation` field and builder method.

### 2. Declare elicitation capability (`maestro-server/src/session_handler.rs` ~line 420)

Change:
```rust
.client_capabilities(ClientCapabilities::new().terminal(true))
```
To:
```rust
.client_capabilities(
    ClientCapabilities::new()
        .terminal(true)
        .elicitation(ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()))
)
```

This tells agents that maestro supports form-based elicitation. We don't declare URL elicitation since the UI doesn't support it.

### 3. Validate request in handler (`session_handler.rs` ~line 384)

In the untyped handler, after confirming method is `"elicitation/create"`, parse the params into the typed struct:

```rust
let elicitation: CreateElicitationRequest = serde_json::from_value(request.params().clone())
    .map_err(|e| acp::Error::new(-32602, format!("invalid elicitation request: {e}")))?;
```

Extract `message` from the typed struct. Continue forwarding — the untyped handler still needs to pass data through, but now we've validated it won't blow up.

### 4. Validate response before sending back (same handler, ~line 399-402)

When the oneshot resolves with the frontend's JSON response, validate it parses as a valid `CreateElicitationResponse`:

```rust
let response = rx.await.map_err(|_| {
    acp::Error::new(-32603, "elicitation channel closed")
})?;
let _validated: CreateElicitationResponse = serde_json::from_value(response.clone())
    .map_err(|e| acp::Error::new(-32603, format!("invalid elicitation response: {e}")))?;
responder.respond(response)
```

### 5. Enrich protocol bridge (`maestro-protocol/src/lib.rs`)

Update `ElicitationRequest` to carry structured data alongside raw payload:
```rust
pub struct ElicitationRequest {
    pub session_id: String,
    pub request_id: String,
    pub message: String,
    pub payload: serde_json::Value,
}
```

The `message` field lets the Tauri/frontend layer access the human-readable prompt without parsing the raw payload. The full `payload` is still passed for the form renderer.

### 6. Update maestro-server sender (session_handler.rs)

Populate the new `message` field from the validated `CreateElicitationRequest`:
```rust
let msg = MaestroRpcMessage::Response(
    ServerResponse::ElicitationRequest(MaestroElicitationRequest {
        session_id: sid,
        request_id,
        message: elicitation.message.clone(),
        payload,
    }),
);
```

### 7. Update Tauri event emission (`src-tauri/src/acp/manager.rs`)

The emitted event payload now includes the `message` field (comes for free from serde on the updated struct).

### 8. Update frontend types/consumption

In `useAcpSessionLifecycle.ts`, update the event payload type:
```typescript
listen<{ request_id: string; message: string; payload: Record<string, unknown> }>
```

In `AgentActivityPanel.tsx`, use `pendingElicitation.message` directly instead of extracting it from raw payload in `parseElicitationFields`. The `parseElicitationFields` function simplifies — it no longer needs to extract `message` from `payload`.

## Files Modified

1. `maestro-server/Cargo.toml` — add schema dep
2. `maestro-server/src/session_handler.rs` — capability declaration + request/response validation
3. `maestro-protocol/src/lib.rs` — add `message` field to `ElicitationRequest`
4. `src-tauri/src/acp/manager.rs` — no code change needed (serde handles new field)
5. `src/components/execution/activity/useAcpSessionLifecycle.ts` — update event type
6. `src/components/execution/AgentActivityPanel.tsx` — use `.message` directly
7. `src/components/execution/activity/ElicitationPrompt.tsx` — simplify `parseElicitationFields`

## Verification

1. `cd maestro-server && cargo check` — confirms schema dep + typed imports compile
2. `cd maestro-protocol && cargo check` — confirms updated struct compiles
3. `cd src-tauri && cargo check` — confirms Tauri side handles updated protocol struct
4. `pnpm test ElicitationPrompt` — if test exists
5. `pnpm lint && pnpm format` — frontend passes checks
6. Manual test: start Tauri dev, trigger an elicitation (Claude Code AskUserQuestion), confirm form renders and response goes through
