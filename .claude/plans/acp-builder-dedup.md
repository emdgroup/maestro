# Deduplicate ACP builder chain in session_handler.rs

## Context

`maestro-server/src/session_handler.rs` has ~150 lines of identical ACP client builder boilerplate copy-pasted 3 times:

1. `spawn_acp_session` (~line 448-596)
2. `load_acp_session` (~line 746-893)
3. `pre_initialize_agent` (~line 1346-1494)

Each copies the same `.on_receive_request(permission)`, `.on_receive_notification(notification)`, `.on_receive_request(create_terminal)`, `.on_receive_request(terminal_output)`, `.on_receive_request(release_terminal)`, `.on_receive_request(wait_for_terminal_exit)`, `.on_receive_request(kill_terminal)`, `.on_receive_request(elicitation)` handler chain. The only difference between the three is what happens inside `.connect_with()`:

- `spawn_acp_session`: sends `InitializeRequest` → `NewSessionRequest` → `attach_session` → `run_command_loop`
- `load_acp_session`: sends `InitializeRequest` → `LoadSessionRequest` → `attach_session` → `run_command_loop`
- `pre_initialize_agent`: sends `InitializeRequest` only → returns capabilities without creating a session

## Proposed Fix

Extract a method on `ConnectionHandlers` that configures all standard handlers on a builder, returning the configured builder:

```rust
impl ConnectionHandlers {
    fn configure_builder(
        &self,
        terminals: Arc<Mutex<HashMap<String, TerminalHandle>>>,
    ) -> acp::ClientBuilder {
        acp::Client
            .builder()
            .name("maestro-server")
            .on_receive_request(/* permission — uses self.clone() */)
            .on_receive_notification(/* notification — uses self.clone() */)
            .on_receive_request(/* create_terminal — uses self.clone() */)
            .on_receive_request(/* terminal_output — uses terminals.clone() */)
            .on_receive_request(/* release_terminal — uses terminals.clone() */)
            .on_receive_request(/* wait_for_terminal_exit — uses terminals.clone() */)
            .on_receive_request(/* kill_terminal — uses terminals.clone() */)
            .on_receive_request(/* elicitation — uses self.clone() */)
    }
}
```

Then each call site becomes:

```rust
let _result = handlers.configure_builder(Arc::clone(&terms))
    .connect_with(transport, async move |cx| {
        // site-specific logic only
    })
    .await;
```

## Complexity Notes

- The `acp` crate's builder API uses generics/type-state for handler registration. Need to verify the builder type is expressible as a return type (may need `impl` return or a type alias).
- Terminal handlers need `Arc<Mutex<HashMap<String, TerminalHandle>>>` cloned from `ConnectionHandlers.terminals` — already available on `self`.
- The `connect_with` closure differs significantly between the 3 sites, so only the handler registration is deduplicated.

## Verification

1. `cargo check` in `maestro-server/`
2. `cargo test` in `maestro-server/`
3. Manual: spawn session, load session, pre-initialize — all work correctly
