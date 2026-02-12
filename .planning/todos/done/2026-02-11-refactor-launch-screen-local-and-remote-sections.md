---
created: 2026-02-11T13:53
title: Refactor launch screen with local and remote sections
area: ui
files:
  - src/components/ProjectPicker.tsx
  - src/App.tsx
  - src-tauri/src/ipc/handlers.rs
  - src-tauri/src/db/schema.rs
---

## Problem

The current launch screen only supports local project selection. Users need the ability to connect to remote projects via SSH, with a unified interface for managing both local and remote project access.

Current limitations:
- No remote project support
- No recently opened projects list
- No SSH connection management
- No password persistence for remote connections

This enhancement is critical for users who work with remote development environments and need seamless switching between local and remote projects.

## Solution

### UI Architecture

**Refactor ProjectPicker.tsx into a single-screen layout with two visual sections side-by-side (or stacked):**

#### 1. Local Section
- **Section Header** - "Local" or "Local Projects"
- **Recently opened local projects list** - Display as clickable list items, sorted by most recent first
  - Show project name and path
  - Click opens project immediately
- **Bottom Action** - "Select Project" button opens filesystem picker dialog
- **Path validation** - Automatically remove non-existent paths from recent projects list on app startup
- **Selection behavior** - Selected project moves to top of recent list (via IPC to persist in database)

#### 2. Remote Section
- **Section Header** - "Remote" or "Remote Projects"
- **Registered SSH connections list** - Display as clickable items, sorted by most recently used first
  - Show connection string (username@host:port)
  - Click initiates connection attempt
- **Bottom Action** - Connection string input field with "Connect" button
  - Format: `user@host:port` or `user@host` (defaults to port 22)
  - Initiates SSH connection on click

#### Connection Flow (Credential-less First)
1. **Initial connection attempt** - Try connecting without credentials first:
   - Attempt SSH agent authentication
   - Attempt using saved password from OS keyring
   - Attempt using saved key file (if configured)
2. **Password modal on auth failure** - If all automatic auth methods fail:
   - Show password modal with input field
   - "Save password" checkbox option (stores in OS keyring)
   - Retry connection with provided password
3. **Project selection screen** - After successful SSH connection:
   - Navigate to remote project selection screen
   - "Select Project" button opens **remote filesystem picker**
   - Remote filesystem picker browses directories on remote host
   - Selecting a remote directory creates the project with ssh_config
4. **Connection persistence** - Successful connections automatically added to registered list

### Data Model Changes

**Database schema additions:**

```sql
-- SSH Connections table
CREATE TABLE ssh_connections (
  id INTEGER PRIMARY KEY,
  connection_string TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER DEFAULT 22,
  saved_password TEXT, -- encrypted, nullable
  last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Recent Projects table (replaces/extends settings key-value)
CREATE TABLE recent_projects (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  ssh_connection_id INTEGER, -- nullable, NULL for local projects
  last_opened_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE CASCADE
);
```

### IPC Handler Additions

New Tauri commands needed:
- `get_recent_projects` - Returns list of recent projects with validation
- `validate_project_path(path: String)` - Checks if local path exists
- `remove_recent_project(project_id: i64)` - Removes from recent list
- `get_ssh_connections` - Returns registered SSH connections
- `create_ssh_connection(connection_string, username, host, port, password, save_password)` - Adds new connection
- `test_ssh_connection(connection_id)` - Tests existing connection
- `get_remote_folders(connection_id, path)` - Lists remote directories
- `update_ssh_last_used(connection_id)` - Updates last_used_at timestamp

### Component Structure

```
ProjectPicker.tsx (refactored)
├── LocalSection.tsx (new)
│   ├── LocalProjectsList.tsx (new)
│   └── FileSystemPicker (existing Tauri dialog)
└── RemoteSection.tsx (new)
    ├── SSHConnectionsList.tsx (new)
    ├── SSHConnectionInput.tsx (new)
    └── PasswordModal.tsx (new)
```

### Security Considerations

- Password encryption using OS keyring (e.g., `keyring` crate for Rust)
- SSH key-based auth support (future enhancement)
- Secure storage of credentials
- Connection timeout handling

### UX Flow

1. **App Launch** → Single screen with two sections (Local | Remote) side-by-side
   - Local section shows recent local projects + "Select Project" button
   - Remote section shows recent SSH connections + connection string input + "Connect" button
   - Recent projects auto-validated and cleaned up on app launch

2. **Local Project Selection:**
   - Click recent project → opens immediately
   - Click "Select Project" button → filesystem picker → select folder → project opens

3. **Remote Project Selection:**
   - **Option A - Recent Connection:** Click saved connection → auto-connect (credential-less) → on success: navigate to remote project picker → select remote folder → project opens
   - **Option B - New Connection:** Enter connection string → click "Connect" → auto-connect attempt → on auth failure: password modal → re-connect with password → on success: navigate to remote project picker → select remote folder → project opens

4. **Remote Project Picker Screen:**
   - Shows same layout as main launch screen
   - Remote section now shows browsable directory structure
   - "Select Project" button opens remote filesystem picker (instead of local)
   - Selecting folder creates project with ssh_config and returns to main app
