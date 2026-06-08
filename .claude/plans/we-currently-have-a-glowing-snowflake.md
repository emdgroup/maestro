# Plan: Align config option workflow with ACP spec

## Context

Per ACP spec, `SetSessionConfigOptionRequest` response contains `config_options: Vec<SessionConfigOption>` — the **complete** config state after the change. Currently maestro-server discards this response (`Ok(_)` pattern) and only sends back a minimal ack (just the confirmed `config_id` + `value`).

Additionally, the spec states: "The current value of a config option can be changed at any point during a session, whether the Agent is idle or generating a response." But our selectors are currently disabled during generation.

Goal: Use the `SetSessionConfigOptionResponse.config_options` as the authoritative source. Remove all workarounds (including claude-acp merge logic). Enable config changes mid-generation.

## Changes

### 1. maestro-protocol: New unified response type

Add a response variant that carries the full config state from the agent:

```rust
pub struct ConfigOptionUpdatedResponse {
    pub session_id: String,
    pub config_id: String,
    pub value: String,
    pub config_options: Vec<serde_json::Value>, // raw SessionConfigOption payloads
}
```

Use `Vec<serde_json::Value>` to avoid duplicating ACP schema types in the protocol crate. Keep legacy `SetModelOk` / `SetModeOk` / `SetConfigOptionOk` for agents on legacy API (MethodNotFound fallback path).

### 2. maestro-server command_loop.rs: Extract response data

In `SetModel`, `SetMode`, `SetConfigOption` handlers:
- `Ok(_)` → `Ok(response)`
- Serialize `response.config_options` to JSON values
- Send `ConfigOptionUpdatedResponse` with full state
- Legacy fallback path: still sends minimal `SetModelOk` / `SetModeOk`

### 3. Tauri manager.rs: Handle new response

On `ConfigOptionUpdatedResponse`:
- Update `current_model_id` / `current_mode_id` by scanning config_options for "model"/"mode" entries and reading their currentValue
- Update agent cache — full replacement of config_options (this is authoritative)
- Emit `acp://config-state-updated/{log_id}` with the full config_options payload to frontend

### 4. Frontend useAcpSessionLifecycle.ts: Trust response, remove workarounds

On `config-state-updated` event:
- **Full replacement** of `configOptions` and `configValues`. No merge logic, no AUTHORITATIVE_KEYS exclusion.
- Remove the existing merge workaround entirely (the `existingIds` / `AUTHORITATIVE_KEYS` logic in the `config_option_update` handler)

For `config_option_update` notifications (agent-initiated):
- Also full replacement. Same treatment as `config-state-updated`. The agent is telling us its current state — trust it.

### 5. Remove the "SetMode re-send hack"

Remove the code in `manager.rs` (around lines 812-828 and 1436-1459) that re-sends SetMode after SpawnOk/SessionLoadOk. With the response now carrying full state, this is unnecessary.

If the agent doesn't provide config options in SpawnOk (some don't), the first user-initiated config change will populate them via the response.

### 6. Enable config selectors during generation

In `ComposeBar.tsx` line 787: remove `disabled={isProcessing}` — config selectors should always be enabled.

The `handleConfigChange` in `AgentActivityPanel.tsx` (line 386) has an early return `if (isProcessing) return;` — remove that guard too.

## Files to modify

| File | Change |
|------|--------|
| `maestro-protocol/src/lib.rs` | Add `ConfigOptionUpdatedResponse` variant + struct |
| `maestro-server/src/session/command_loop.rs` | Extract response.config_options, send new response type |
| `src-tauri/src/acp/manager.rs` | Handle `ConfigOptionUpdatedResponse`, update cache authoritatively, remove re-send hack |
| `src/components/execution/activity/useAcpSessionLifecycle.ts` | Add `config-state-updated` listener, simplify `config_option_update` to full replacement, remove merge workarounds |
| `src/components/execution/activity/ComposeBar.tsx` | Remove `disabled={isProcessing}` from config selectors |
| `src/components/execution/agent-activity-panel/AgentActivityPanel.tsx` | Remove `isProcessing` guard in `handleConfigChange` |

## Verification

1. `cargo check` in workspace root
2. `pnpm build` (frontend types)
3. Manual: change model mid-generation → selector stays enabled, change takes effect
4. Manual: change mode → full config state updates (effort appears)
5. Manual: verify no stale option lists after switching models
