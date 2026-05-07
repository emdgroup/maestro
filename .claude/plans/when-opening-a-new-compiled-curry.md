# Wire up ACP session modes to permission mode dropdown

## Context

Permission mode dropdown in ComposeBar is hardcoded (`useState("ask")` with static options). Should work like model selector — available modes and current mode fetched from ACP agent dynamically.

ACP SDK (v0.12.0) already provides:
- `SessionModeState` = `{ current_mode_id, available_modes: Vec<SessionMode> }`
- `SetSessionModeRequest` / `SetSessionModeResponse`
- `SessionUpdate::CurrentModeUpdate` notification (already forwarded opaquely)
- `NewSessionResponse.modes` + `LoadSessionResponse.modes`

Maestro currently ignores all mode data. Only models are wired up.

## Progress

- [x] Step 1: maestro-protocol wire types
- [x] Step 2: maestro-server extract + route
- [x] Step 3: src-tauri manager cache + events
- [x] Step 4: src-tauri IPC commands + registration
- [ ] Step 5: Frontend dynamic dropdown
- [ ] Step 6: Evaluate auto-approve removal
- [ ] Verification: pnpm tauri:gen, cargo test, pnpm dev

## Implementation (follows exact model selector pattern)

### 1. maestro-protocol — Wire types ✅

**File:** `maestro-protocol/src/lib.rs`

Add structs:
- `ModeInfo { mode_id, name, description: Option<String> }`
- `SessionModeState { current_mode_id, available_modes: Vec<ModeInfo> }`
- `SetModeRequest { session_id, mode_id }`
- `SetModeOkResponse { session_id, mode_id }`

Add enum variants:
- `ServerRequest::SetMode(SetModeRequest)`
- `ServerResponse::SetModeOk(SetModeOkResponse)`

Add field to existing structs:
- `SpawnResponse.modes: Option<SessionModeState>` (with `skip_serializing_if` + `serde(default)`)
- `SessionLoadOkResponse.modes: Option<SessionModeState>`

### 2. maestro-server — Extract + route ✅

**Files:** `sessions.rs`, `session_handler.rs`, `main.rs`

- Add `SessionCommand::SetMode(String)` variant
- Add `convert_acp_modes()` (parallel to `convert_acp_models`)
- Extract `modes` from `NewSessionResponse` and `LoadSessionResponse`
- Handle `SessionCommand::SetMode` → send `SetSessionModeRequest` to ACP agent → respond `SetModeOk`
- Route `ServerRequest::SetMode` in main.rs dispatch
- Include modes in SpawnOk/SessionLoadOk responses

### 3. src-tauri/src/acp/manager.rs — Cache + events ✅

- Add `modes: Arc<Mutex<Option<SessionModeState>>>` to `AcpProcess`
- On SpawnOk/SessionLoadOk: cache modes, emit `acp://session-modes/{log_id}`
- On SetModeOk: update cache `current_mode_id`, emit `acp://mode-changed/{log_id}`
- Parse `CurrentModeUpdate` from SessionUpdate payloads → update cache + emit `mode-changed`

### 4. src-tauri/src/ipc/acp_handlers.rs — IPC commands ✅

- Add `AcpSessionModeState` / `AcpModeInfo` DTOs with `#[specta(export)]`
- `get_acp_modes(log_id)` → reads cache (parallel to `get_acp_models`)
- `set_acp_mode(log_id, mode_id)` → writes SetModeRequest to session
- Register both in `lib.rs`

### 5. Frontend — Dynamic dropdown

**`pnpm tauri:gen`** — regenerate bindings first. Will produce `getAcpModes`, `setAcpMode`, `AcpSessionModeState`, `AcpModeInfo` types in `src/types/bindings.ts`.

**`useAcpSessionLifecycle.ts`:** (mirror models pattern at lines 33-35, 118-155)
- Add `ModeOption` type: `{ id: string; label: string }` (parallel to `ModelOption` at line 8)
- Add state: `modes`, `modeId` (no `modesLoaded` — don't gate readiness)
- Initial fetch via `api.getAcpModes(sessionKey)` in useEffect (parallel to line 118-129 pattern)
- Listen `acp://session-modes/${sessionKey}` → hydrate modes + modeId (parallel to line 132-145)
- Listen `acp://mode-changed/${sessionKey}` → update modeId only (parallel to line 148-155)
- Return `modes`, `modeId` from hook

**`AgentActivityPanel.tsx`:** (line 56 has hardcoded `useState<PermissionMode>("ask")`)
- Remove `const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask")`
- Use `modes`/`modeId` from lifecycle hook return
- Add `handleModeChange` callback: calls `api.setAcpMode(sessionKey, id)` (parallel to `handleModelChange` at line 128-137)
- Replace ComposeBar props (lines 397-399): `permissionMode` → `modes`+`modeId`, `onPermissionModeChange` → `onModeChange`

**`ComposeBar.tsx`:**
- Remove `PermissionMode` type export (line 20)
- Replace props: `permissionMode`/`onPermissionModeChange` → `modes: ModeOption[]`, `modeId: string`, `onModeChange: (id: string) => void`
- Replace hardcoded Select (lines 635-654) with dynamic `modes.map()` (mirror model Select at lines 618-633)
- Hide dropdown when `modes.length === 0` (agent doesn't support modes)
- Update Shift+Tab cycling (lines 302-308): use `modes` array instead of hardcoded `["ask", "auto", "plan"]`

### 6. Remove auto-approve of `switch_mode` permissions

The auto-approve logic (AgentActivityPanel lines 218-228) that silently approves `isPlanPermission` requests becomes unnecessary once the mode is properly managed through the modes API. Evaluate whether to remove it or keep it as fallback.

## Key decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Parse `CurrentModeUpdate` | Rust layer (manager.rs) | Matches SetModelOk pattern; keeps cache fresh |
| No modes from agent | Hide dropdown | Same as model selector |
| No optimistic UI | Wait for `mode-changed` event | Less latency-sensitive than models |
| Don't gate `isReady` on modesLoaded | Correct | Modes optional; shouldn't block UI |

## Critical files

1. `maestro-protocol/src/lib.rs`
2. `maestro-server/src/sessions.rs`
3. `maestro-server/src/session_handler.rs`
4. `maestro-server/src/main.rs`
5. `src-tauri/src/acp/manager.rs`
6. `src-tauri/src/ipc/acp_handlers.rs`
7. `src-tauri/src/lib.rs`
8. `src/components/execution/activity/useAcpSessionLifecycle.ts`
9. `src/components/execution/AgentActivityPanel.tsx`
10. `src/components/execution/activity/ComposeBar.tsx`

## Verification

1. `cargo check` in maestro-server and src-tauri
2. `cargo test` in maestro-protocol (roundtrip serialization)
3. `pnpm tauri:gen` to regenerate TypeScript bindings
4. `pnpm dev` + open agent session → dropdown should show agent-provided modes with correct current selection
5. Change mode via dropdown → should send `SetModeRequest` and update on confirmation
6. Agent-initiated mode change → dropdown should update reactively
