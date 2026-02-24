# Phase 18: Maestro Folder Architecture & Rebranding - Research

**Researched:** 2026-02-22
**Domain:** Project-local configuration storage, database-to-file migration, Tauri app rebranding
**Confidence:** HIGH

## Summary

Phase 18 represents a fundamental architectural shift from database-centric to project-local storage. This research covers three primary areas:

1. **Project-Local Storage Architecture** - Transitioning from SQLite database storage to .maestro folder with JSON-based state management while maintaining backwards compatibility with existing projects.

2. **Database Migration Strategy** - Designing and implementing the migration from database to file-based storage, including detection of legacy projects, data export, folder initialization, and verification.

3. **Application Rebranding** - Comprehensive rebranding from "GSD Orchestrator" to "Maestro" across configuration, UI, code comments, and documentation.

**Key insight:** The shift to project-local storage reduces app complexity (no global database queries for project state), enables easier project sharing/version control, and supports future features like multi-project workflows. The rebranding consolidates the project identity after v1.0/v1.1 phases.

**Primary recommendation:** Implement project-local storage with .maestro folder containing settings.json (project config), state.json (tasks/worktrees), and logs/ directory. Keep global database for appearance settings and recent projects list only. Create automatic migration system that detects and transforms legacy projects. Phase the rebranding across: code identifiers, UI strings, config files, then documentation.

## Standard Stack

### Core Libraries (Rust Backend)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| serde_json | 1.0+ | JSON serialization/deserialization | Official Rust JSON library; HIGH confidence from Context7 |
| std::fs | builtin | File system operations (create dirs, read/write) | Standard library, no external dependency needed |
| serde | 1.0+ with derive | Struct serialization to JSON | Already in project; HIGH confidence |
| chrono | 0.4+ | Timestamp generation for state files | Already in project for database timestamps |

### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|------------|
| std::path | builtin | Path manipulation and validation | Cross-platform path handling |
| std::io | builtin | Error handling for file operations | Already used throughout project |

### No New Dependencies Required
The project already has serde, serde_json, chrono, and std::fs available. No new Cargo dependencies needed for Phase 18.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| JSON files | TOML files | JSON more web-friendly for future REST API; TOML more human-readable but harder to generate dynamically |
| Flat .maestro/ | Nested structure (state/, config/, logs/) | Flat structure simpler to understand; nested better at scale (beyond scope of this phase) |
| Single state.json | Multiple files per entity | Single file simpler for initial phase; splitting later if performance becomes issue |

## Architecture Patterns

### Recommended Project Structure

**File System Structure (per project):**

```
project_root/
├── .maestro/                          # Project-local configuration folder
│   ├── settings.json                 # Project settings (model default, MCP, skills)
│   ├── state.json                    # Task state (tasks list, worktree status)
│   └── logs/                         # Optional: execution logs (can stay in DB for v1)
├── .git/                             # Existing git repo
├── worktrees/                        # Git worktrees (existing structure)
└── [other project files]
```

**Rust Module Structure:**

```
src-tauri/src/
├── db/
│   ├── schema.rs                     # (existing - global DB only for appearance settings)
│   └── project_storage.rs            # NEW: Project-local file I/O operations
├── models/
│   ├── project_state.rs              # NEW: Models for .maestro/state.json content
│   ├── project_config.rs             # NEW: Models for .maestro/settings.json content
│   └── [existing models]
├── ipc/
│   ├── migration_handlers.rs          # NEW: Migration IPC commands
│   └── [existing handlers]
└── lib.rs                            # Re-export new modules
```

### Pattern 1: Project-Local Configuration Files

**What:** Each project contains `.maestro/settings.json` with project-specific configuration (model default, MCP allowlist, skills).

**When to use:** For any configuration that varies per project and should be shared when the project is shared/version-controlled.

**Rust Implementation Example:**

```rust
// src-tauri/src/models/project_config.rs
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectConfig {
    pub model_default: String,           // e.g., "claude-opus-4-5"
    pub mcp_allowlist: Vec<String>,      // e.g., ["filesystem", "web"]
    pub skills_default: Vec<String>,     // e.g., ["javascript", "rust"]
    pub updated_at: String,              // ISO 8601 timestamp
}

impl ProjectConfig {
    /// Load project configuration from .maestro/settings.json
    pub fn load_from_project(project_path: &str) -> Result<Self, String> {
        let config_path = format!("{}/.maestro/settings.json", project_path);
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", config_path, e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Invalid JSON in settings.json: {}", e))
    }

    /// Save project configuration to .maestro/settings.json
    pub fn save_to_project(&self, project_path: &str) -> Result<(), String> {
        let maestro_dir = format!("{}/.maestro", project_path);
        std::fs::create_dir_all(&maestro_dir)
            .map_err(|e| format!("Failed to create .maestro dir: {}", e))?;

        let config_path = format!("{}/settings.json", maestro_dir);
        let json = serde_json::to_string_pretty(&self)
            .map_err(|e| format!("Serialization failed: {}", e))?;

        std::fs::write(&config_path, json)
            .map_err(|e| format!("Failed to write settings.json: {}", e))
    }
}

// Example settings.json content:
// {
//   "model_default": "claude-opus-4-5",
//   "mcp_allowlist": ["filesystem", "web"],
//   "skills_default": ["javascript", "rust"],
//   "updated_at": "2026-02-22T14:30:00+00:00"
// }
```

**Source:** Serde JSON documentation (Context7: /serde-rs/json)

### Pattern 2: Project State File

**What:** `.maestro/state.json` contains task state, worktree status, and execution logs - all per-project state currently in database.

**When to use:** For runtime state that changes as tasks execute. Enables "snapshot" of project state within the project folder.

**Rust Implementation Example:**

```rust
// src-tauri/src/models/project_state.rs
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectState {
    pub tasks: Vec<TaskSnapshot>,
    pub worktrees: Vec<WorktreeSnapshot>,
    pub updated_at: String,
    pub schema_version: u32,  // For future migrations
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TaskSnapshot {
    pub id: i32,
    pub name: String,
    pub description: String,
    pub status: String,  // "Backlog", "Ready", "InProgress", "Review", "Done"
    pub skills: Vec<String>,
    pub model_override: Option<String>,
    pub mcp_allowlist: Option<Vec<String>>,
    pub skills_override: Option<Vec<String>>,
    pub created_at: String,
    pub updated_at: String,
}

impl ProjectState {
    pub fn load_from_project(project_path: &str) -> Result<Self, String> {
        let state_path = format!("{}/.maestro/state.json", project_path);
        let content = std::fs::read_to_string(&state_path)
            .map_err(|e| format!("Failed to read state.json: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Invalid state.json: {}", e))
    }

    pub fn save_to_project(&self, project_path: &str) -> Result<(), String> {
        let maestro_dir = format!("{}/.maestro", project_path);
        std::fs::create_dir_all(&maestro_dir)
            .map_err(|e| format!("Failed to create .maestro dir: {}", e))?;

        let state_path = format!("{}/state.json", maestro_dir);
        let json = serde_json::to_string_pretty(&self)
            .map_err(|e| e.to_string())?;

        std::fs::write(&state_path, json)
            .map_err(|e| format!("Failed to write state.json: {}", e))
    }
}
```

### Pattern 3: Backward Compatibility Detection

**What:** Detect existing projects without `.maestro/` folder and automatically migrate them.

**When to use:** On app startup and when opening a project to ensure all projects have migrated data.

**Logic:**

```rust
// Detection function
pub fn needs_migration(project_path: &str) -> bool {
    let maestro_path = format!("{}/.maestro", project_path);
    !std::path::Path::new(&maestro_path).exists()
}

// Migration workflow
pub async fn migrate_legacy_project(
    project_id: i32,
    project_path: String,
    db: &Connection,
) -> Result<(), String> {
    // Step 1: Load project settings from database
    let model_default = load_setting(&db, "model_default")?;
    let mcp_allowlist = load_setting_json(&db, "mcp_allowlist")?;
    let skills_default = load_setting_json(&db, "skills_default")?;

    // Step 2: Create ProjectConfig and save to .maestro/settings.json
    let config = ProjectConfig {
        model_default,
        mcp_allowlist,
        skills_default,
        updated_at: Utc::now().to_rfc3339(),
    };
    config.save_to_project(&project_path)?;

    // Step 3: Load all tasks and worktrees from database for this project
    let tasks = load_tasks_from_db(&db, project_id)?;
    let worktrees = load_worktrees_from_db(&db, project_id)?;

    // Step 4: Create ProjectState and save to .maestro/state.json
    let state = ProjectState {
        tasks: tasks.iter().map(|t| task_to_snapshot(t)).collect(),
        worktrees: worktrees.iter().map(|w| worktree_to_snapshot(w)).collect(),
        updated_at: Utc::now().to_rfc3339(),
        schema_version: 1,
    };
    state.save_to_project(&project_path)?;

    // Step 5: Mark project as migrated (add flag to database or settings)
    mark_project_migrated(&db, project_id)?;

    Ok(())
}
```

### Pattern 4: Application Rebranding

**What:** Systematically rename references from "GSD Orchestrator" to "Maestro" across code, config, and UI.

**When to use:** Post-architectural migration when identity consolidation makes sense.

**Scope:**

```
Configuration Files:
├── src-tauri/tauri.conf.json
│   └── productName: "GSD Agent Orchestrator" → "Maestro"
│   └── identifier: "com.gsd.orchestrator" → "com.maestro.app"
│   └── windows[0].title: "GSD Agent Orchestrator" → "Maestro"
├── src-tauri/Cargo.toml
│   └── description: "AI Agent Orchestrator" → "Maestro: AI Agent Orchestrator"
│   └── package name stays "maestro" (internal identifier)
└── package.json
    └── name: "maestro" (stays for compatibility)

Code References (Rust):
├── Comments and doc strings: Update "GSD" → "Maestro"
├── Error messages: Update any "GSD" references
└── Internal identifiers: Keep "gsd" prefix for CLI compatibility

UI Strings:
├── App title/header: "GSD Agent Orchestrator" → "Maestro"
├── Window titles: Update all references
├── Help text: Update to reference "Maestro"
└── Keep technical references to ".planning/" and command names

Documentation:
├── README.md: Update project name and references
├── CLAUDE.md: Update references in project description
└── Phase documentation: Update for new branding
```

**Keep Technical (backward compatible):**
- Folder names: `.planning/`, `.maestro/` (already intentional)
- Command names: `maestro` (Tauri app identifier used by CLI)
- Rust crate name: `gsd_demo` (internal, not user-facing)
- Git commands/worktrees: Existing workflows unchanged

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON serialization to files | Custom read/write logic | serde + serde_json | Battle-tested, handles edge cases (Unicode, escaping, formatting) |
| Cross-platform path handling | String concatenation with "/" | std::path::Path | Handles Windows \\ vs Unix /, relative/absolute paths |
| Detecting missing directories | Manual existence checks | std::fs::create_dir_all | Idempotent, creates parent directories, handles permissions |
| Timestamp generation | System::time::now() | chrono crate (already in project) | Consistent with existing database timestamps (RFC3339 format) |
| Migration state tracking | File existence only | Add "migrated_at" timestamp to database | Allows retry logic and audit trail of migrations |

**Key insight:** Migration logic is more complex than it appears. Without proper state tracking, re-running migrations can cause data loss or conflicts. Use database flags to mark completion, not just file existence checks.

## Common Pitfalls

### Pitfall 1: Path Handling Breaks on Windows

**What goes wrong:** Hardcoding "/" in paths like `format!("{}/{}", project_path, ".maestro")` works on Linux/Mac but fails on Windows which uses backslashes.

**Why it happens:** Developer tests only on Unix-like systems; Windows path separator differs.

**How to avoid:** Always use `std::path::Path` and `PathBuf` for construction, or use `format!` with `{:?}` to get proper OS-specific paths.

**Prevention code:**
```rust
// ❌ Bad - hardcoded separator
let maestro_path = format!("{}/.maestro", project_path);

// ✅ Good - OS-aware
use std::path::Path;
let maestro_path = Path::new(&project_path).join(".maestro");
let maestro_str = maestro_path.to_string_lossy();
```

**Warning signs:** Tests pass locally but fail on CI/Windows systems; user reports file not found errors on Windows.

### Pitfall 2: Migration Runs Multiple Times, Corrupting Data

**What goes wrong:** No tracking of whether migration already happened. Running migrate_legacy_project twice overwrites state.json with stale data from database, losing any in-app changes since first migration.

**Why it happens:** Developers assume "file doesn't exist = not migrated" but files can be created by previous runs that failed halfway through.

**How to avoid:** Add explicit "migrated_at" timestamp to database projects table. Check this flag, not file existence.

**Prevention code:**
```rust
// ❌ Bad - file existence only
if !Path::new(&format!("{}/.maestro/state.json", project_path)).exists() {
    migrate_legacy_project(project_id, project_path, db)?;
}

// ✅ Good - database flag with idempotent migration
#[derive(Debug, sqlx::FromRow)]
struct ProjectMigrationStatus {
    id: i32,
    migrated_at: Option<String>,  // NULL = not migrated
}

let status = db.query_row(
    "SELECT id, migrated_at FROM projects WHERE id = ?",
    [project_id],
    |row| Ok(ProjectMigrationStatus {
        id: row.get(0)?,
        migrated_at: row.get(1)?
    })
)?;

if status.migrated_at.is_none() {
    migrate_legacy_project(project_id, project_path, db)?;
    db.execute("UPDATE projects SET migrated_at = ? WHERE id = ?",
        [Utc::now().to_rfc3339(), project_id.to_string()])?;
}
```

**Warning signs:** Users report duplicate tasks, missing recent data, or "I lost my changes" errors after app restart.

### Pitfall 3: JSON Schema Breaking on Minor Updates

**What goes wrong:** Add a new field to ProjectConfig (e.g., `theme_preference`), but existing projects have old settings.json without that field. Deserialization fails with "missing field" error.

**Why it happens:** Serde's derive macro is strict by default. Old JSON files lack new fields.

**How to avoid:** Use `#[serde(default)]` for new optional fields, or implement custom deserialization with sensible defaults.

**Prevention code:**
```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub model_default: String,
    pub mcp_allowlist: Vec<String>,
    pub skills_default: Vec<String>,
    pub updated_at: String,

    // ✅ New field with default - old JSON files still parse
    #[serde(default)]
    pub theme_preference: Option<String>,
}
```

**Warning signs:** App crashes when loading old project; error logs show "missing field theme_preference".

### Pitfall 4: Rebranding Incomplete, Causing Confusion

**What goes wrong:** Update UI strings but leave code comments and error messages with "GSD". Users see "Maestro" in header but "GSD" in error messages. Or database still references "gsd_orchestrator" in error messages.

**Why it happens:** Rebranding is tedious; developers skip "boring" areas like comments and errors.

**How to avoid:** Create a rebranding checklist. Use grep to find all references systematically. Update in phases: config (high-visibility), UI strings (user-facing), code comments (internal).

**Prevention code:**
```bash
# Find all remaining "GSD Orchestrator" references
grep -r "GSD Orchestrator" --include="*.rs" --include="*.tsx" --include="*.json" src-tauri/ src/

# Find remaining "gsd_orchestrator" identifiers (should be rare after rebranding config)
grep -r "gsd_orchestrator" --include="*.rs" src-tauri/
```

**Warning signs:** Users report mixed branding in UI; support tickets mention confusion about app name.

### Pitfall 5: Global Database Still Queried for Project State

**What goes wrong:** After migrating to .maestro folder, app still queries database for tasks (performance regression), or data gets out of sync between DB and file.

**Why it happens:** Gradual migration - developers update some paths to file I/O but not others.

**How to avoid:** During migration phase, systematically replace ALL database queries for project-specific data (tasks, worktrees, execution logs) with file I/O. Create a clear boundary: database queries only for global settings (theme, appearance) and recent projects list.

**Prevention code:**
```rust
// ❌ Bad - still querying database for project tasks
pub fn get_tasks(project_id: i32, conn: &Connection) -> Result<Vec<Task>> {
    let mut stmt = conn.prepare("SELECT * FROM tasks WHERE project_id = ?")?;
    // ... database query
}

// ✅ Good - load from project state file
pub fn get_tasks(project_path: &str) -> Result<Vec<Task>> {
    let state = ProjectState::load_from_project(project_path)?;
    Ok(state.tasks.into_iter().map(task_snapshot_to_task).collect())
}

// Migrate IPC handler
#[tauri::command]
pub fn get_tasks(project_id: i32, app_state: State<Arc<AppState>>) -> Result<Vec<Task>> {
    // Step 1: Get project path from database
    let project = db.get_project(project_id)?;
    // Step 2: Load tasks from .maestro/state.json, not database
    get_tasks(&project.path)
}
```

**Warning signs:** Performance doesn't improve after migration; users report stale task data.

## Code Examples

### Example 1: Load Project State from .maestro Folder

```rust
// Source: Serde JSON Context7 + std::fs patterns
use serde::{Deserialize, Serialize};
use chrono::Utc;

#[derive(Debug, Serialize, Deserialize)]
struct ProjectState {
    tasks: Vec<TaskSnapshot>,
    worktrees: Vec<WorktreeSnapshot>,
    updated_at: String,
}

pub fn load_project_state(project_path: &str) -> Result<ProjectState, String> {
    use std::path::Path;

    let state_file = Path::new(project_path)
        .join(".maestro")
        .join("state.json");

    let content = std::fs::read_to_string(&state_file)
        .map_err(|e| format!("Cannot read state.json: {}", e))?;

    serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON in state.json: {}", e))
}

pub fn save_project_state(project_path: &str, state: &ProjectState) -> Result<(), String> {
    use std::path::Path;

    let maestro_dir = Path::new(project_path).join(".maestro");
    std::fs::create_dir_all(&maestro_dir)
        .map_err(|e| format!("Failed to create .maestro directory: {}", e))?;

    let state_file = maestro_dir.join("state.json");
    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Serialization failed: {}", e))?;

    std::fs::write(&state_file, json)
        .map_err(|e| format!("Failed to write state.json: {}", e))
}
```

### Example 2: Detect and Migrate Legacy Project

```rust
// Source: Project-specific migration pattern
use std::path::Path;

pub fn detect_legacy_project(project_path: &str) -> bool {
    let maestro_marker = Path::new(project_path).join(".maestro");
    !maestro_marker.exists()
}

pub async fn ensure_project_migrated(
    project_id: i32,
    project_path: &str,
    conn: &Connection,
) -> Result<(), String> {
    // Step 1: Check if already migrated
    let migrated_at: Option<String> = conn.query_row(
        "SELECT migrated_at FROM projects WHERE id = ?",
        [project_id],
        |row| row.get(0),
    ).ok();

    if migrated_at.is_some() {
        return Ok(()); // Already migrated
    }

    // Step 2: Migrate legacy project
    println!("Migrating legacy project: {}", project_path);

    let config = load_project_config_from_database(conn)?;
    config.save_to_project(project_path)?;

    let state = load_project_state_from_database(conn, project_id)?;
    state.save_to_project(project_path)?;

    // Step 3: Mark migrated in database
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE projects SET migrated_at = ? WHERE id = ?",
        rusqlite::params![&now, project_id],
    ).map_err(|e| e.to_string())?;

    println!("Migration complete for project: {}", project_path);
    Ok(())
}
```

### Example 3: Update Tauri Config for Rebranding

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Maestro",
  "version": "0.2.0",
  "identifier": "com.maestro.app",
  "build": {
    "beforeDevCommand": "pnpm dev --host",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "title": "Maestro",
        "width": 1200,
        "height": 800,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Monolithic SQLite DB for all app state | Hybrid: Global DB for theme + project-local .maestro for state | Phase 18 | Reduces coupling, enables easier project sharing, supports future multi-project workflows |
| Database-only configuration storage | .maestro/settings.json + database (global only) | Phase 18 | Makes project config version-controllable, portable across machines |
| App name "GSD Orchestrator" | Rebranded to "Maestro" | Phase 18 | Consolidates identity post-v1.0/v1.1, clearer user-facing name |

**Deprecated/Outdated:**
- Storing all project state in database: Replaced by project-local .maestro folder structure (better encapsulation)
- Global settings table for project-specific config: Replaced by .maestro/settings.json (better organization)

## Open Questions

1. **Should execution logs migrate to .maestro/logs/?**
   - What we know: Execution logs currently stored in database execution_logs table
   - What's unclear: Whether execution logs should move to filesystem or stay in global DB
   - Recommendation: Keep in database for Phase 18 (scope reduction). Future phase can move if needed. Logs are append-only and non-critical to project portability.

2. **How to handle recent projects list with file-based storage?**
   - What we know: Global database tracks recently opened projects
   - What's unclear: Should recent projects list contain project paths or database IDs?
   - Recommendation: Store project paths (absolute or relative) in database. On startup, validate that paths still exist and .maestro folder is present. Update last_opened timestamp from project state file timestamp.

3. **Should .maestro folder be .gitignore'd?**
   - What we know: .maestro contains active state (task status, worktree references)
   - What's unclear: User workflow expectation - should state be version-controlled?
   - Recommendation: Do NOT ignore .maestro by default. Leave to user preference. Document that git-tracking state creates merge conflicts; recommend .gitignore if sharing repos between agents.

4. **Backwards compatibility for very old projects (pre-v1.0)?**
   - What we know: Phase 18 is first migration (v1.0 had database storage)
   - What's unclear: Edge case where app data directory got corrupted and projects still reference old database schema
   - Recommendation: Check PRAGMA user_version before migration. If version < 1, skip migration and error with clear message. Phase 19+ can handle schema version upgrades.

## Sources

### Primary (HIGH confidence)

- **Serde JSON (Context7: /serde-rs/json)** - JSON serialization patterns, write to file examples
- **Serde (Context7: /websites/serde_rs)** - Struct serialization with derive macros, optional field handling
- **Rust std::fs** - Official documentation for file operations, path handling (builtin)
- **Rust std::path::Path** - Cross-platform path construction (builtin)
- **Project Codebase** - Phase 7 (07-RESEARCH.md) for configuration patterns; Phase 14-17 for Tauri architecture

### Secondary (MEDIUM confidence)

- **Current project database schema (src-tauri/src/db/schema.rs)** - Existing models and data structures to migrate
- **Tauri configuration (src-tauri/tauri.conf.json)** - Current branding strings that need updates
- **Project CLAUDE.md and .planning/PROJECT.md** - Architectural vision and project scope

### Tertiary (Referenced but not heavily relied upon)

- **Industry patterns** - Many projects (VS Code, Git, npm) use dotfolder patterns for project-local config; Maestro follows established convention

## Metadata

**Confidence breakdown:**
- Standard stack (file I/O, serde): **HIGH** - Verified with Context7, used throughout codebase
- Architecture patterns: **HIGH** - Derived from existing phase patterns and current codebase structure
- Pitfalls: **HIGH** - Based on real migration scenarios and backwards compatibility requirements
- Rebranding: **MEDIUM** - Straightforward string replacements, but requires systematic audit

**Research date:** 2026-02-22
**Valid until:** 2026-03-22 (stable phase, no breaking changes expected)
**Next review:** If major Tauri or serde version upgrades occur, or if requirements change regarding execution log storage

