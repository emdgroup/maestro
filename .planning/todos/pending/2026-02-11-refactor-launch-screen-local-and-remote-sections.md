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

**Refactor ProjectPicker.tsx into two main sections:**

#### 1. Local Section
- **"Local Projects" button** - Entry point to local project selection
- **Recently opened local projects list** - Display as clickable list items, sorted by most recent first
- **"Select Project" button** - Opens filesystem picker dialog
- **Path validation** - Automatically remove non-existent paths from recent projects list
- **Selection behavior** - Selected project moves to top of recent list (via IPC to persist in database)

#### 2. Remote Section
- **Registered SSH connections list** - Display as clickable items, sorted by most recently used first
- **Connection string input field** - Format: `user@host:port` or `user@host`
- **"Connect" button** - Initiates SSH connection
- **Password modal** - Prompts for password on new connections or when saved password fails
  - "Save password" checkbox option
  - Re-prompts if connection refused or password not saved
- **Project selection screen** - Same UI as local, but filesystem picker shows remote folders
- **Connection persistence** - Successful connections added to registered list

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

1. User opens app → sees refactored launch screen with Local and Remote sections
2. **Local flow:** Click "Local Projects" → see recent list + "Select Project" button → select → project opens
3. **Remote flow:** Enter connection string → click "Connect" → password modal → success → remote project picker → select project → opens
4. Recent projects auto-validated and cleaned up on each app launch
