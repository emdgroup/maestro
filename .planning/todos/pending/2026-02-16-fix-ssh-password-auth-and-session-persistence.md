---
created: 2026-02-16T10:30
title: Fix SSH password authentication and session persistence
area: ssh
files:
  - src/components/ProjectPicker.tsx
  - src/components/PasswordModal.tsx
  - src-tauri/src/ipc/ssh_handlers.rs
  - src-tauri/src/db/AppState.rs (or equivalent)
  - src/index.css
---

## Problem

SSH connection password authentication flow has multiple critical issues preventing proper usage:

### Issue 1: Double Password Prompt
- **Current behavior**: User is prompted for password TWICE:
  1. First prompt when adding new SSH connection
  2. Second prompt when selecting a project folder
- **Expected behavior**: User should be prompted ONCE per app session, even if "Save password" is unchecked
- **Root cause**: SSH session is not persisting between the initial connection test and project folder selection

### Issue 2: SSH Agent Error After Password Auth
- **Error message**: `SSH Authentication Error: SSH agent authentication failed: [Session(-42)] unable to connect to agent pipe`
- **When it occurs**: After successfully connecting with password, when trying to open a project folder
- **Workaround**: Restart app, then select the connection again (works on second try)
- **Root cause**: Unknown - session state issue or auth method mismatch between frontend and backend

### Issue 3: Connection Added Before Establishment
- **Current behavior**: SSH connection appears in recent connections list immediately when user submits connection string
- **Expected behavior**: Connection should only be added to list AFTER successful authentication
- **Impact**: Failed connections clutter the recent list

### Issue 4: Native Password Reveal Button Styling
- **Current behavior**: Password input has no native browser reveal button visible, or it's not styled
- **Expected behavior**: Native browser password reveal button (eye icon) should be visible and styled with accent color
- **Note**: User wants the NATIVE browser feature styled, not a custom toggle button
- **CSS pseudo-element**: `::-ms-reveal` (Chrome/Edge) or equivalent for other browsers

## Previous Failed Attempts

### Attempt 1 (Commits 8b70d76 and b9d0279 - REVERTED)

**Mistakes Made**:

1. **Misunderstood session persistence**:
   - Thought password auth should be re-attempted for each operation
   - Did NOT understand that SSH session in Rust backend should persist across IPC calls
   - Frontend kept re-authenticating instead of reusing established session

2. **Wrong fix for auth method**:
   - Modified backend to conditionally update `auth_method` in database based on `save_password` flag
   - This was irrelevant to the actual problem
   - The issue is session STATE management, not database persistence

3. **Added custom password toggle**:
   - Added Eye/EyeOff icons with custom React button
   - User wanted NATIVE browser reveal button styled, not a custom implementation

4. **Reloaded connection from database unnecessarily**:
   - Frontend reloaded SSH connection from database after password auth
   - This doesn't fix the session persistence issue
   - Session is stored in Rust backend `AppState`, not in database

5. **Changed timing of view switching**:
   - Modified when ProjectPicker switches from connections to projects view
   - This was a UI flow change that doesn't address the core session issue

**What I Learned**:
- SSH sessions are managed in Rust backend via `AppState.set_ssh_session(connection_id, session)`
- Frontend doesn't manage sessions - it just calls backend IPC commands with `connection_id`
- The `auth_method` in database is for INITIAL connection attempt, not for ongoing session
- Password authentication creates a session that should persist until app closes

## Technical Findings

### SSH Session Management Flow (Current Understanding)

**Backend (Rust)**:
- `AppState` contains `ssh_sessions: Arc<Mutex<HashMap<i64, RemoteSshSession>>>`
- `connect_ssh_with_password()` creates session and stores it: `app_state.set_ssh_session(connection_id, session)`
- `create_project()` should retrieve and use this stored session
- Sessions should persist in memory until app closes

**Frontend (React)**:
- Does NOT manage SSH sessions directly
- Only stores connection metadata (id, host, username, auth_method from database)
- Calls backend IPC commands with `connection_id` as identifier

### Expected Flow (Correct Behavior)

**Adding New SSH Connection**:
1. User enters `user@host:port` connection string
2. Frontend calls `save_ssh_connection()` - saves to database with default `auth_method: "Agent"`
3. Frontend attempts `connect_ssh_without_credentials(connection_id)`
4. If fails (needs password), show password modal
5. User enters password (checkbox for "save password")
6. Frontend calls `connect_ssh_with_password(connection_id, password, save_password)`
7. Backend creates SSH session and stores in `AppState.ssh_sessions[connection_id]`
8. If `save_password = true`, password saved to OS keyring
9. Backend optionally updates database `auth_method` to `"Password"` if password saved
10. Frontend switches to projects view
11. **Connection should now appear in recent list (not before)**

**Selecting Project Folder (Same Session)**:
1. User clicks "Select New" button
2. Frontend calls `list_remote_directories(connection_id, path)` to show FilePicker
3. Backend retrieves session from `AppState.get_ssh_session(connection_id)` - **should already exist**
4. **NO password prompt needed** - session is already authenticated
5. User selects folder
6. Frontend calls `create_project(name, path, isRemote, sshConfig)`
7. Backend uses existing session from `AppState` - **NO re-authentication needed**

**After App Restart**:
1. User selects SSH connection from recent list
2. Frontend calls `connect_ssh_without_credentials(connection_id)`
3. Backend reads `auth_method` from database
4. If `auth_method = "Password"` and password in keyring, use it
5. If `auth_method = "Agent"` or password not in keyring, prompt for password
6. Session established, continue as above

## Root Cause Hypotheses

### Hypothesis 1: Session Not Persisting Between IPC Calls
- `connect_ssh_with_password()` stores session in AppState
- But `list_remote_directories()` or `create_project()` doesn't find it
- Possible reasons:
  - Session is stored with wrong connection_id key
  - Session is being cleared/dropped prematurely
  - AppState is not shared correctly between IPC handlers

### Hypothesis 2: create_project() Creates New Connection
- `create_project()` might be creating a NEW SSH connection instead of reusing session
- Need to verify if it calls `RemoteSshSession::new()` and `connect()` again
- If so, it would try to authenticate with database `auth_method` (still "Agent") instead of using stored session

### Hypothesis 3: Connection Added to Recent List Too Early
- `save_ssh_connection()` or some other call adds connection to recent list before auth succeeds
- Recent list should only show AUTHENTICATED connections

## Solution Approach (Proposed)

### Fix 1: Ensure Session Persistence
1. Verify `AppState.set_ssh_session()` is called correctly in `connect_ssh_with_password()`
2. Verify `create_project()` calls `AppState.get_ssh_session()` instead of creating new connection
3. Add logging to track session lifecycle:
   - When session is stored
   - When session is retrieved
   - If session is missing when expected

### Fix 2: Prevent Double Password Prompt
1. `handleRemoteSelectProject()` should NOT call `connect_ssh_without_credentials()` if session already exists
2. Backend should return error if session not found, then frontend prompts for password
3. BUT on first connection, session IS stored, so second prompt shouldn't happen

### Fix 3: Add Connection to List After Auth
1. Move connection addition to recent list to AFTER successful authentication
2. Or use a "pending" state for connections not yet authenticated

### Fix 4: Style Native Password Reveal Button
1. Research correct CSS pseudo-element for password reveal button
2. For Chrome/Edge: `::-ms-reveal { color: var(--accent); }`
3. For Safari: May need different approach (research needed)
4. For Firefox: May not have native reveal button
5. Test in actual browser (not just CSS theory)

## Investigation Steps

1. **Read `create_project()` implementation**:
   - Check if it calls `get_ssh_session()` or creates new connection
   - Verify how `sshConfig.auth_method` is used

2. **Read `AppState` implementation**:
   - Verify `set_ssh_session()` and `get_ssh_session()` work correctly
   - Check if sessions are stored in Arc<Mutex<HashMap>>

3. **Add debug logging**:
   - Log in `connect_ssh_with_password()` when session is stored
   - Log in `list_remote_directories()` when session is retrieved
   - Log in `create_project()` to see if session exists

4. **Test native password reveal**:
   - Create minimal HTML test file
   - Test `::-ms-reveal`, `::-webkit-credentials-auto-fill-button` pseudo-elements
   - Verify which properties work (color, filter, etc.)

## Success Criteria

- [ ] User prompted for password ONCE per app session (not per operation)
- [ ] After successful password auth, folder selection works without re-prompt
- [ ] No "SSH agent authentication failed" error when opening project
- [ ] Connections only appear in recent list after successful authentication
- [ ] Native password reveal button is visible and styled with accent color
- [ ] "Save password" checkbox works: if checked, no prompt after app restart; if unchecked, prompt after restart

## Notes

- Do NOT modify `auth_method` persistence logic - this is not the problem
- Do NOT add custom Eye/EyeOff toggle - style the native browser feature
- Do NOT change ProjectPicker view switching timing - this is UI flow, not core issue
- FOCUS on session persistence between IPC calls
- The key is that Rust backend manages sessions, frontend just passes connection_id
