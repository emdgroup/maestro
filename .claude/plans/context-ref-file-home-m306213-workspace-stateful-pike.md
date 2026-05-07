# Deduplicate ACP builder chain via macro

## Context

`maestro-server/src/session_handler.rs` has ~150 lines of identical ACP client builder boilerplate copy-pasted 3 times (spawn, load, pre-initialize). The builder uses type-state generics (`Builder<Host, impl HandleDispatchFrom<...>, Runner>`) — each `.on_receive_request()` returns an unnameable type. A function returning the configured builder is impossible without boxing. A macro is the correct approach.

## Implementation

### 1. Define `configure_acp_builder!` macro (~line 47, before `impl ConnectionHandlers`)

```rust
macro_rules! configure_acp_builder {
    ($handlers:expr, $terms:expr) => {
        acp::Client
            .builder()
            .name("maestro-server")
            .on_receive_request(/* permission */)
            .on_receive_notification(/* notification */)
            .on_receive_request(/* create_terminal */)
            .on_receive_request(/* terminal_output */)
            .on_receive_request(/* release_terminal */)
            .on_receive_request(/* wait_for_terminal_exit */)
            .on_receive_request(/* kill_terminal */)
            .on_receive_request(/* elicitation */)
    };
}
```

Macro captures `$handlers` (a `ConnectionHandlers`) and `$terms` (an `Arc<Mutex<HashMap<String, TerminalHandle>>>`), clones them into each closure exactly as the current code does.

### 2. Replace 3 call sites

Each becomes:
```rust
let _result = configure_acp_builder!(handlers, terms)
    .connect_with(transport, async move |cx| {
        // site-specific logic unchanged
    })
    .await;
```

Call sites:
- `spawn_acp_session` (~line 449)
- `load_acp_session` (~line 746)
- `pre_initialize_agent` (~line 1347)

## Files Modified

- `maestro-server/src/session_handler.rs`

## Verification

1. `cargo check -p maestro-server`
2. `cargo test -p maestro-server`
3. Existing integration test covers spawn/load paths
