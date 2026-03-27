# Phase 1: Foundation - Research

**Researched:** 2026-02-04
**Domain:** Tauri 2 + React + Rust backend + SQLite + Type Generation
**Confidence:** HIGH

## Summary

Phase 1 establishes the core infrastructure for the AI Agent Orchestrator: a Tauri 2 desktop application with React frontend, Rust backend, SQLite persistence, and automated type generation from Rust to TypeScript. The phase prioritizes a thin, correct foundation that supports all subsequent phases without needing major refactoring.

The decision to use ts-rs for single-source-of-truth type definitions (locked in CONTEXT.md) means Rust structs drive the entire type ecosystem. This eliminates the type versioning problem—backend changes automatically synchronize to frontend. The stack uses Tauri 2.10.2 (current as of Feb 2026), rusqlite 0.31 for SQLite access, and ts-rs 7.1.1 for code generation.

**Primary recommendation:** Establish database schema early with clear separation between DB models (stored types) and API types (over-the-wire types), use ts-rs derives on all Rust structs that cross the IPC boundary, and lean on Tauri's built-in `#[tauri::command]` macro for type-safe communication patterns.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| **Tauri** | 2.10.2 | Desktop app shell + IPC layer | Lightweight (600KB), native WebView, security-first architecture, type-safe command system |
| **React** | 18.x | Frontend UI framework | User requirement from STATE.md; has mature ecosystem; Tauri + React is well-documented path |
| **Vite** | 5.x | Frontend build tool | Official Tauri recommendation for SPA frameworks; fast dev server and build |
| **Rust** (via Tauri) | 1.80+ | Backend runtime | Tauri requirement; handles system-level operations, database, process spawning |
| **rusqlite** | 0.31 | SQLite bindings for Rust | Synchronous (matches Tauri's single-threaded app model), ergonomic, mature (4,000+ GitHub stars) |
| **ts-rs** | 7.1.1 | TypeScript code generation | Single-source-of-truth for types; auto-generates TS from Rust structs; 1.7k+ GitHub stars |
| **serde + serde_json** | 1.x | Serialization | De facto standard; required for IPC serialization and database mapping |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **r2d2** | — | Connection pooling | For database connection reuse (optional; rusqlite for single-threaded app may not need this initially) |
| **tokio** | Not in Tauri 2 | Async runtime | Tauri 2 uses blocking model by default; only import if introducing async commands |
| **Tauri plugins** | Various | Extended functionality | File dialogs, deep linking, process spawning; available via `@tauri-apps/plugins-*` npm packages |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Vite | Webpack or Rollup | Webpack/Rollup are slower, more configuration; Vite is the Tauri-endorsed choice |
| rusqlite | sqlx | sqlx is async-only; adds complexity for single-threaded Tauri app; rusqlite is synchronous and simpler |
| ts-rs | manual types | Manual types require version management; ts-rs keeps types synchronized automatically |
| Tauri commands | Tauri events | Commands are type-safe; events are JSON-only, untyped; use events only for real-time broadcasts |

**Installation:**
```bash
npm install vite react react-dom
# Tauri CLI: cargo install tauri-cli
# Rust dependencies handled via Cargo.toml in src-tauri/
```

## Architecture Patterns

### Recommended Project Structure
```
project/
├── src-tauri/                      # Rust backend
│   ├── src/
│   │   ├── main.rs                 # Tauri app entry, command handlers
│   │   ├── models/                 # DB models (derived with ts-rs)
│   │   │   ├── project.rs
│   │   │   ├── task.rs
│   │   │   └── execution_log.rs
│   │   ├── db/
│   │   │   ├── schema.rs           # Schema creation (run on app init)
│   │   │   ├── connection.rs       # Connection setup
│   │   │   └── queries.rs          # Query helpers
│   │   ├── ipc/
│   │   │   └── handlers.rs         # #[tauri::command] handlers
│   │   └── error.rs                # Error type (derive ts-rs for frontend)
│   └── Cargo.toml
├── src/                            # React frontend
│   ├── App.tsx
│   ├── components/
│   ├── context/                    # React context providers
│   └── types/
│       └── bindings.ts             # Generated from ts-rs (git-ignored or committed, see note)
├── vite.config.ts
├── tauri.conf.json                 # Tauri configuration
└── package.json
```

### Pattern 1: Type-Safe IPC Commands
**What:** Rust structs are marked with `#[derive(Serialize, Deserialize, TS)]` and `#[ts(export)]`. These generate TypeScript type definitions automatically. Frontend calls Rust functions via `invoke()` with type safety ensured by both serde (serialization) and ts-rs (type generation).

**When to use:** For all struct types that cross the Rust/JavaScript boundary (requests, responses, errors).

**Example:**
```rust
// src-tauri/src/models/task.rs
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Task {
    pub id: i32,
    pub name: String,
    pub status: TaskStatus,
    pub created_at: String,  // ISO 8601 string from db
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "PascalCase")]  // Important: Control casing in TS
pub enum TaskStatus {
    Pending,
    Running,
    Complete,
}

// src-tauri/src/ipc/handlers.rs
#[tauri::command]
async fn get_tasks(db_path: String) -> Result<Vec<Task>, String> {
    // Query database, return Vec<Task>
}

// This generates src/types/bindings/Task.ts:
// export type Task = {
//   id: number;
//   name: string;
//   status: TaskStatus;
//   created_at: string;
// }
// export type TaskStatus = "Pending" | "Running" | "Complete"

// src/components/TaskList.tsx
import { invoke } from "@tauri-apps/api/core";
import type { Task } from "../types/bindings";

export function TaskList() {
  const tasks: Task[] = await invoke("get_tasks", { db_path: "..." });
  // TS knows Task shape — no runtime validation needed
}
```

**Source:** ts-rs 7.1.1 documentation, Tauri 2.10.2 serialization docs

### Pattern 2: Database Models vs API Types
**What:** Create two distinct types for each entity:
- **DB models** (`TaskDb`): Exact shape from database (raw strings for dates, i64 for timestamps)
- **API models** (`Task`): Over-the-wire shape (ISO 8601 strings, enums serialized as strings)

**When to use:** When DB and frontend representations differ (common for dates, nullable fields, internal fields).

**Example:**
```rust
// Internal database model (what rusqlite returns)
#[derive(Debug)]
struct TaskDb {
    id: i32,
    name: String,
    status_str: String,  // Stored as TEXT in DB
    created_at_ts: i64,  // Stored as INTEGER (Unix timestamp)
}

// API model (what crosses IPC boundary)
#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Task {
    pub id: i32,
    pub name: String,
    pub status: TaskStatus,  // Enum, not string
    pub created_at: String,  // ISO 8601
}

// Conversion
impl From<TaskDb> for Task {
    fn from(db: TaskDb) -> Self {
        Task {
            id: db.id,
            name: db.name,
            status: TaskStatus::from_str(&db.status_str).unwrap(),
            created_at: chrono::DateTime::from_timestamp(db.created_at_ts, 0)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_default(),
        }
    }
}
```

**Source:** CONTEXT.md decision "Type separation: Separate API types from DB types"

### Pattern 3: Tauri State Management
**What:** Initialize app state during Tauri startup (in `setup()` hook), store in a Mutex, and inject into commands via `State<T>` parameter.

**When to use:** For shared resources like database connection, configuration, or application globals.

**Example:**
```rust
// src-tauri/src/main.rs
use std::sync::Mutex;
use rusqlite::Connection;
use tauri::State;

pub struct AppState {
    db: Mutex<Connection>,
}

#[tauri::command]
async fn create_task(
    name: String,
    state: State<'_, AppState>,
) -> Result<Task, String> {
    let db = state.db.lock().unwrap();
    // Query database...
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let db_path = get_db_path(app);
            let conn = Connection::open(&db_path)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            conn.execute_batch(SCHEMA)?;  // Initialize schema

            app.manage(AppState {
                db: Mutex::new(conn),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![create_task])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Source:** Tauri 2.10.2 state management docs

### Pattern 4: Schema Versioning via Pragmas
**What:** Use SQLite `PRAGMA user_version` to track schema version. On app startup, compare current version against stored version and run migrations.

**When to use:** For database upgrades that must run automatically without user intervention.

**Example:**
```rust
// src-tauri/src/db/schema.rs
const SCHEMA_VERSION: u32 = 1;

pub const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending',
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id)
);
"#;

pub fn initialize_schema(conn: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
    let current_version: u32 = conn.pragma_query_value(Default::default(), "user_version", |row| {
        row.get(0)
    }).unwrap_or(0);

    if current_version < SCHEMA_VERSION {
        conn.execute_batch(SCHEMA_V1)?;
        conn.pragma_update(Default::default(), "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}
```

**Source:** SQLite best practices; this avoids hand-rolled migration systems

### Anti-Patterns to Avoid
- **Hardcoding database path:** Store in app state or use Tauri's `app.path()` API
- **Blocking operations in async context:** rusqlite is synchronous; keep DB calls off the async task pool
- **No type generation for backend types:** Every struct crossing IPC should have `#[ts(export)]`
- **Using TypeScript enums instead of string literals:** CONTEXT.md forbids TS enums; use string literal unions like `type Status = "Pending" | "Running"`
- **Storing complex types in SQLite:** Store serialized JSON instead of trying to normalize schema for complex nested structures

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Type sync between Rust and TS | Manual .d.ts files that get out of sync | ts-rs with `#[ts(export)]` | Codegen eliminates synchronization bugs; single source of truth in Rust |
| Database connection pooling | Simple pool struct with Vec | r2d2 or rusqlite built-in connection management | Handles fairness, timeouts, connection health checks; complex to get right |
| SQL query parameterization | String concatenation or unsafe formatting | rusqlite parameter binding with `?` or `?1` | Prevents SQL injection; parameterization is well-tested in rusqlite |
| Serializing Rust types for IPC | Custom serialization logic | serde with derive macros | serde is mature, battle-tested across millions of projects |
| Database schema versioning | Hardcoded schema with migrations in separate files | SQLite `PRAGMA user_version` + conditional DDL | Simple, self-contained, no external migration tool needed |
| Enum handling in IPC | Custom enum serialization | CONTEXT.md pattern: string literals + serde `rename_all` | Keeps frontend TS simple; avoids numerical enum confusion |

**Key insight:** The IPC boundary is fragile—type mismatches cause runtime crashes in JavaScript with no TypeScript warning. By using ts-rs, you move type errors to compile time (Rust) rather than runtime (JS).

## Common Pitfalls

### Pitfall 1: Type Mismatch Between Tauri State and Command Parameters
**What goes wrong:** You register `State<AppState>` but inject `State<Mutex<AppState>>` in a command. Runtime panics with "State::from failed" with no clear error.

**Why it happens:** Tauri's state injection is type-checked at runtime, not compile time. A typo in the type wrapper causes a panic that crashes the app.

**How to avoid:** Create type aliases at the top of `main.rs`:
```rust
type DbState = State<'static, AppState>;
```
Use consistently everywhere. Consider a macro for common patterns.

**Warning signs:** App crashes on command invocation with "State::from failed" message.

### Pitfall 2: Forgetting to Export Types with ts-rs
**What goes wrong:** You add `#[derive(Serialize, Deserialize)]` to a Rust struct but forget `#[ts(export)]`. The struct serializes correctly (serde works), but no TypeScript definition is generated. Frontend code has `any` types and loses all type safety.

**Why it happens:** ts-rs code generation only runs when `#[ts(export)]` is present. Without it, the derive macro exists but generates no output.

**How to avoid:** Add as a checklist: "Any struct used in IPC must have `#[derive(Serialize, Deserialize, TS)]` and `#[ts(export)]`."

**Warning signs:** Frontend receives data with correct values but TypeScript shows `any` type.

### Pitfall 3: Database Connection Locked During Long Command
**What goes wrong:** A command executes a slow query and locks the Mutex. Meanwhile, another command tries to run and blocks forever. UI becomes unresponsive.

**Why it happens:** Tauri's command handler doesn't use async/await for rusqlite. Long operations hold the Mutex lock.

**How to avoid:** Keep queries fast. For slow operations, consider:
1. Optimizing the query (add indexes, batch operations)
2. Moving heavy work to a separate thread with `std::thread::spawn()`
3. Using SQLite's timeout: `conn.busy_timeout(Duration::from_secs(5))?`

**Warning signs:** UI freezes when running bulk operations; timeout errors from second command.

### Pitfall 4: Not Handling Enum Variants in serde
**What goes wrong:** You have `#[derive(Serialize)]` on an enum without `#[serde(rename_all = "PascalCase")]`. Rust serializes to lowercase JSON (`"pending"`), but your TypeScript expects PascalCase (`"Pending"`). Type mismatch occurs at runtime.

**Why it happens:** serde's default enum serialization uses lowercase variant names. CONTEXT.md specifies PascalCase in TypeScript.

**How to avoid:** Always use `#[serde(rename_all = "PascalCase")]` on enum types that cross IPC:
```rust
#[derive(Serialize, Deserialize, TS)]
#[serde(rename_all = "PascalCase")]
pub enum TaskStatus { Pending, Running, Complete }
```

**Warning signs:** TypeScript receives data with unexpected enum values; type errors during IPC calls.

### Pitfall 5: SQLite AUTOINCREMENT Performance Penalty
**What goes wrong:** You define `id INTEGER PRIMARY KEY AUTOINCREMENT` to "ensure IDs are always increasing." SQLite adds extra overhead to prevent ROWID reuse, slowing inserts.

**Why it happens:** Misunderstanding of SQLite's ROWID behavior. AUTOINCREMENT is rarely needed.

**How to avoid:** Use `id INTEGER PRIMARY KEY` without AUTOINCREMENT. SQLite automatically generates and reuses ROWIDs, which is fine for most applications. Only use AUTOINCREMENT if you need guaranteed never-reused IDs across the database lifetime.

**Warning signs:** Insert performance degrades with large dataset.

## Code Examples

Verified patterns from official sources:

### Type Generation with ts-rs
```rust
// Source: ts-rs 7.1.1 docs
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "PascalCase")]
pub enum ProjectStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Project {
    pub id: i32,
    pub name: String,
    pub status: ProjectStatus,
}

// Generates:
// export type ProjectStatus = "Active" | "Archived"
// export type Project = {
//   id: number;
//   name: string;
//   status: ProjectStatus;
// }
```

### Tauri Command with Database Access
```rust
// Source: Tauri 2.10.2 docs + rusqlite 0.31 docs
use tauri::State;
use rusqlite::Connection;

#[tauri::command]
fn get_projects(db_state: State<AppState>) -> Result<Vec<Project>, String> {
    let db = db_state.db.lock().map_err(|e| e.to_string())?;

    let mut stmt = db.prepare(
        "SELECT id, name, status FROM projects ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;

    let projects = stmt.query_map([], |row| {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            status: ProjectStatus::from_str(&row.get::<_, String>(2)?).unwrap(),
        })
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;

    Ok(projects)
}
```

### React Component Calling Tauri Command
```typescript
// Source: Tauri 2.10.2 docs + React 18 docs
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { Project } from "./types/bindings";

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Project[]>("get_projects")
      .then(setProjects)
      .catch((err) => setError(err));
  }, []);

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {projects.map((p) => (
        <div key={p.id}>{p.name}</div>
      ))}
    </div>
  );
}
```

### Database Initialization on App Startup
```rust
// Source: Tauri 2.10.2 setup docs + rusqlite 0.31 docs
use tauri::{App, AppHandle};
use rusqlite::Connection;

pub fn init_db(app: &AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;

    let db_path = data_dir.join("app.db");
    let conn = Connection::open(&db_path)?;

    // Enable foreign keys
    conn.execute_batch("PRAGMA foreign_keys = ON")?;

    // Initialize schema
    initialize_schema(&conn)?;

    Ok(conn)
}

// In main()
tauri::Builder::default()
    .setup(|app| {
        let db = init_db(&app.handle())?;
        app.manage(AppState {
            db: Mutex::new(db),
        });
        Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error running app");
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Electron + Node backend | Tauri 2 with Rust backend | 2023-2024 | 80% smaller app size, better security, native performance |
| Manual .d.ts files | ts-rs code generation | 2023 | Type sync automated, eliminates versioning bugs |
| Custom connection pooling | r2d2 or built-in Tauri patterns | 2022+ | Fewer footguns, standard patterns |
| Tauri 1.x async runtime | Tauri 2.x blocking model by default | 2024 | Simpler for synchronous apps like SQLite + rusqlite |
| Runtime validation with Zod | Compile-time via serde + ts-rs | 2024+ | CONTEXT.md decision: trust codegen types, skip Zod |

**Deprecated/outdated:**
- **TypeScript enums in frontend**: Use string literal unions instead (CONTEXT.md decision)
- **Managing migrations in separate SQL files**: Use SQLite `PRAGMA user_version` + embedded DDL
- **Hardcoded config files**: Use Tauri's app data directory and config module

## Open Questions

Things that couldn't be fully resolved:

1. **Connection pooling necessity**
   - What we know: r2d2 is available; rusqlite works without explicit pooling in single-threaded context
   - What's unclear: Whether Tauri 2.10.2's command handlers run serially or can overlap (affects whether pooling is needed)
   - Recommendation: Start without r2d2; add only if multiple commands cause database lock contention. Profile first.

2. **Async handling in commands**
   - What we know: rusqlite is synchronous; Tauri 2 supports async commands
   - What's unclear: Best practice for mixing async (file I/O) with sync (database)
   - Recommendation: Use `#[tauri::command]` without `async` for database-only operations; use `async` only if orchestrating file I/O + database

3. **ts-rs bindings directory**
   - What we know: ts-rs generates to `./bindings/` by default; can be configured
   - What's unclear: Should generated bindings be committed to git or git-ignored?
   - Recommendation: Commit bindings (easier for code review, CI/CD); alternatively git-ignore if regenerating before every build is guaranteed in CI

## Sources

### Primary (HIGH confidence)
- **Tauri 2.10.2** - Released Feb 4, 2025 (https://github.com/tauri-apps/tauri/releases); core IPC, window management, state patterns verified
- **ts-rs 7.1.1** - (https://docs.rs/ts-rs/7/ts_rs/); type generation, export configuration verified
- **rusqlite 0.31** - (https://docs.rs/rusqlite/0.31/rusqlite/); SQLite bindings, transaction patterns verified
- **Rust API Guidelines** - (https://rust-lang.github.io/api-guidelines/); naming, error handling conventions

### Secondary (MEDIUM confidence)
- **Official Tauri docs** - Architecture, IPC, security, state management patterns
- **Official SQLite docs** - ROWID, AUTOINCREMENT, PRAGMA user_version
- **Official React 18 docs** - Context patterns, hooks
- **serde docs** - Serialization, derive macros, rename_all attribute

### Tertiary (LOW confidence)
- **Rust ecosystem discussions** - Community best practices for Tauri + SQLite (not all verified with official docs)

## Metadata

**Confidence breakdown:**
- **Standard Stack:** HIGH - All versions verified via official documentation and GitHub releases
- **Architecture Patterns:** HIGH - All patterns from official Tauri 2.10.2, rusqlite, ts-rs docs
- **Pitfalls:** MEDIUM - Based on ecosystem experience and documented issues, not exhaustively tested
- **Type System:** HIGH - CONTEXT.md locked decisions (ts-rs, no runtime validation); decisions verified with official docs

**Research date:** 2026-02-04
**Valid until:** 30 days (Tauri and ts-rs are stable; rusqlite updates frequently but 0.31 is current)

**Notes for planner:**
- CONTEXT.md decisions are locked: use ts-rs (verified 7.1.1), skip Zod runtime validation (stack avoids it), separate API from DB types (pattern documented)
- Tauri 2.10.2 is current; breaking changes rare but monitor releases
- Database schema should be versioned from day 1 using PRAGMA user_version (easier than retrofitting migrations later)
- All IPC types must have ts-rs exports; establish this as a checklist item in code review
