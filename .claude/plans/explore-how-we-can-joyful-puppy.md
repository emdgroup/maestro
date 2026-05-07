# Plan: Bundle maestro-server in installer + auto-deploy to remote

## Context

maestro-server must be manually installed on PATH for maestro to function locally, and manually deployed to remote hosts for SSH sessions. Goal: single installer ships both binaries, and remote connections auto-deploy maestro-server via SFTP when missing or version-mismatched.

## Design Overview

**Local**: Bundle `maestro-server` as Tauri resource. Resolve from `resource_dir()` at runtime, fall back to `which` for dev mode.

**Remote**: On SSH connect, check if remote has correct `maestro-server`. If missing or protocol version mismatch → SFTP upload from bundled remote binary, chmod +x, then proceed.

**Decisions locked:**
- Remote install path: `~/.maestro/bin/maestro-server`
- Remote targets: x86_64-unknown-linux-gnu only (initially)
- Upgrade behavior: auto-replace silently (emit status event for UI)
- Bundling mechanism: Tauri `resources` (not `externalBin` sidecar)

---

## Part 1: Local Resource Bundling

### 1.1 Configure resources in `tauri.conf.json`

```json
"bundle": {
  "resources": {
    "resources/maestro-server*": "./",
    "resources/remote/*": "remote/"
  },
  ...
}
```

### 1.2 Add `beforeBundleCommand` to `tauri.conf.json`

```json
"build": {
  "beforeBundleCommand": "cargo run -p xtask",
  ...
}
```

### 1.3 Create `xtask` crate (replaces bash script — cross-platform)

**Why not bash**: `beforeBundleCommand` runs via OS shell. On Windows that's `cmd.exe` — bash scripts won't work without WSL/Git Bash. A Rust xtask binary works everywhere.

**`Cargo.toml` (workspace root)** — add `xtask` to members:
```toml
[workspace]
members = ["src-tauri", "maestro-server", "maestro-protocol", "xtask"]
```

**`xtask/Cargo.toml`**:
```toml
[package]
name = "xtask"
version = "0.1.0"
edition = "2021"
```

**`xtask/src/main.rs`**:
```rust
use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

const REMOTE_TARGET: &str = "x86_64-unknown-linux-gnu";

fn main() {
    let host_target = env::var("TAURI_ENV_TARGET_TRIPLE").unwrap_or_else(|_| detect_host_target());

    let resources = Path::new("src-tauri/resources");
    fs::create_dir_all(resources.join("remote"))
        .expect("Failed to create resources/remote dir");

    // Build local maestro-server
    println!("[xtask] building maestro-server for local: {host_target}");
    cargo_build_server(&host_target);

    let ext = if host_target.contains("windows") { ".exe" } else { "" };
    let local_src = format!("target/{host_target}/release/maestro-server{ext}");
    let local_dst = resources.join(format!("maestro-server{ext}"));
    fs::copy(&local_src, &local_dst)
        .unwrap_or_else(|e| panic!("copy {local_src} → {}: {e}", local_dst.display()));

    // Build remote maestro-server (skip if host == remote target)
    if host_target != REMOTE_TARGET {
        println!("[xtask] building maestro-server for remote: {REMOTE_TARGET}");
        cargo_build_server(REMOTE_TARGET);
    }
    let remote_src = format!("target/{REMOTE_TARGET}/release/maestro-server");
    let remote_dst = resources.join("remote").join(format!("maestro-server-{REMOTE_TARGET}"));
    fs::copy(&remote_src, &remote_dst)
        .unwrap_or_else(|e| panic!("copy {remote_src} → {}: {e}", remote_dst.display()));

    println!("[xtask] done");
}

fn cargo_build_server(target: &str) {
    let status = Command::new("cargo")
        .args(["build", "-p", "maestro-server", "--release", "--target", target])
        .status()
        .expect("failed to run cargo");
    if !status.success() {
        panic!("cargo build failed for target {target}");
    }
}

fn detect_host_target() -> String {
    let output = Command::new("rustc")
        .args(["-vV"])
        .output()
        .expect("failed to run rustc -vV");
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find(|l| l.starts_with("host:"))
        .map(|l| l.trim_start_matches("host:").trim().to_string())
        .expect("could not detect host target from rustc -vV")
}
```

**Note on Windows → Linux cross-compilation**: Building `x86_64-unknown-linux-gnu` from Windows requires a cross-linker (e.g. `cross` tool or Docker). For now, if the remote target can't be built, the xtask panics — user must have cross-compilation set up or build on Linux/macOS.

### 1.3b Fix glob validation in `src-tauri/build.rs`

Tauri's `tauri_build::build()` validates resource glob patterns at compile time. During `cargo build` (before `beforeBundleCommand` runs), the resource files don't exist yet. Fix: create empty stubs in `build.rs` so globs match.

**`src-tauri/build.rs`**:
```rust
fn main() {
    let stubs = [
        "resources/maestro-server",
        "resources/remote/maestro-server-x86_64-unknown-linux-gnu",
    ];
    for path in stubs {
        let p = std::path::Path::new(path);
        if !p.exists() {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::File::create(p);
        }
    }
    tauri_build::build()
}
```

This removes the need for tracked empty stub files in git.

### 1.4 Create `src-tauri/src/acp/resolve.rs`

```rust
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Resolve maestro-server path for local spawning.
/// 1. Resource dir (bundled app)
/// 2. Adjacent to current_exe (fallback)
/// 3. which::which (dev mode)
pub fn resolve_server_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let bin_name = if cfg!(target_os = "windows") {
        "maestro-server.exe"
    } else {
        "maestro-server"
    };

    // Bundled resource
    if let Ok(dir) = app_handle.path().resource_dir() {
        let p = dir.join(bin_name);
        if p.exists() {
            return Ok(p);
        }
    }

    // Adjacent to exe
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(bin_name);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // Dev mode: PATH lookup
    which::which("maestro-server")
        .map_err(|e| format!("maestro-server not found: {}", e))
}

/// Standalone variant without AppHandle (for one_shot_rpc_local).
pub fn resolve_server_path_standalone() -> Result<PathBuf, String> {
    let bin_name = if cfg!(target_os = "windows") {
        "maestro-server.exe"
    } else {
        "maestro-server"
    };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(bin_name);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    which::which("maestro-server")
        .map_err(|e| format!("maestro-server not found: {}", e))
}
```

### 1.5 Replace `which::which("maestro-server")` in 4 locations

| File | Line | Replacement |
|------|------|-------------|
| `src-tauri/src/acp/manager.rs` | 199 | `crate::acp::resolve::resolve_server_path(&app_state.app_handle)?` |
| `src-tauri/src/acp/rpc.rs` | 66 | `crate::acp::resolve::resolve_server_path_standalone()?` |
| `src-tauri/src/ipc/acp_handlers.rs` | 376 | `crate::acp::resolve::resolve_server_path_standalone().ok().map(...)` |
| `src-tauri/src/ipc/acp_handlers.rs` | 896 | `crate::acp::resolve::resolve_server_path(&app_state.app_handle)?` |

### 1.6 Register module in `src-tauri/src/acp/mod.rs`

```rust
pub mod resolve;
```

### 1.7 Gitignore

Add to `src-tauri/.gitignore`:
```
/resources/maestro-server*
/resources/remote/
```

---

## Part 2: Remote Auto-Deploy via SFTP

### 2.1 Add `--protocol-version` flag to maestro-server

`maestro-server/src/main.rs` — before async runtime:

```rust
fn main() {
    if std::env::args().any(|a| a == "--protocol-version") {
        println!("{}", maestro_protocol::PROTOCOL_VERSION);
        return;
    }
    // ... existing tokio::main async code
}
```

### 2.2 Create `src-tauri/src/acp/deploy.rs`

```rust
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use crate::ssh::RemoteSshSession;

const REMOTE_INSTALL_DIR: &str = ".maestro/bin";
const REMOTE_BINARY_NAME: &str = "maestro-server";
const REMOTE_TARGET: &str = "x86_64-unknown-linux-gnu";

#[derive(Clone, serde::Serialize)]
pub struct DeployStatus {
    pub connection_id: i32,
    pub status: String, // "checking" | "deploying" | "deployed" | "up-to-date" | "failed"
    pub message: Option<String>,
}

pub struct DeployResult {
    pub path: String,
    pub deployed: bool,
}

/// Ensure maestro-server exists on remote with correct protocol version.
/// Deploys via SFTP if missing or outdated. Returns remote path to binary.
pub async fn ensure_remote_server(
    ssh: &RemoteSshSession,
    app_handle: &AppHandle,
    connection_id: i32,
) -> Result<DeployResult, String> {
    let remote_path = format!("~/{}/{}", REMOTE_INSTALL_DIR, REMOTE_BINARY_NAME);

    emit_status(app_handle, connection_id, "checking", None);

    // Check remote architecture
    let arch = ssh.execute_command("uname -m").await
        .map_err(|e| format!("Failed to detect remote arch: {}", e))?;
    if arch.trim() != "x86_64" {
        return Err(format!("Unsupported remote architecture: {}", arch.trim()));
    }

    // Check if maestro-server exists and has correct version
    let version_check = ssh.execute_command(
        &format!("{} --protocol-version 2>/dev/null || echo MISSING", remote_path)
    ).await.unwrap_or_else(|_| "MISSING".to_string());

    let remote_version = version_check.trim();
    let local_version = maestro_protocol::PROTOCOL_VERSION.to_string();

    if remote_version == local_version {
        emit_status(app_handle, connection_id, "up-to-date", None);
        return Ok(DeployResult { path: remote_path, deployed: false });
    }

    // Need to deploy
    emit_status(app_handle, connection_id, "deploying", None);

    // Resolve local resource binary for remote target
    let resource_dir = app_handle.path().resource_dir()
        .map_err(|e| format!("Cannot resolve resource dir: {}", e))?;
    let local_binary = resource_dir
        .join("remote")
        .join(format!("maestro-server-{}", REMOTE_TARGET));

    if !local_binary.exists() {
        return Err(format!(
            "Remote binary not bundled: {}",
            local_binary.display()
        ));
    }

    // Create remote directory
    ssh.execute_command(&format!("mkdir -p ~/{}", REMOTE_INSTALL_DIR)).await
        .map_err(|e| format!("Failed to create remote dir: {}", e))?;

    // Expand ~ to actual home path for SFTP (SFTP doesn't expand ~)
    let home = ssh.execute_command("echo $HOME").await
        .map_err(|e| format!("Failed to get remote HOME: {}", e))?;
    let abs_remote_path = format!("{}/{}/{}", home.trim(), REMOTE_INSTALL_DIR, REMOTE_BINARY_NAME);

    // Upload via SFTP
    let transfer_id = format!("deploy-maestro-server-{}", connection_id);
    crate::ssh::sftp::upload_file(
        ssh,
        &local_binary,
        &abs_remote_path,
        &transfer_id,
        app_handle,
    ).await.map_err(|e| format!("SFTP upload failed: {}", e))?;

    // Make executable
    ssh.execute_command(&format!("chmod +x {}", abs_remote_path)).await
        .map_err(|e| format!("chmod failed: {}", e))?;

    emit_status(app_handle, connection_id, "deployed", None);

    Ok(DeployResult { path: abs_remote_path, deployed: true })
}

fn emit_status(app_handle: &AppHandle, connection_id: i32, status: &str, message: Option<String>) {
    let _ = app_handle.emit("maestro-server://deploy-status", DeployStatus {
        connection_id,
        status: status.to_string(),
        message,
    });
}
```

### 2.3 Integrate into `prefetch_agent_discovery`

In `src-tauri/src/ipc/acp_handlers.rs` ~line 355, replace:

```rust
// Before:
let maestro_path = ssh.execute_command("which maestro-server 2>/dev/null")...

// After:
let deploy_result = crate::acp::deploy::ensure_remote_server(
    &ssh, &app_state.app_handle, conn_id
).await;
let maestro_path = deploy_result.ok().map(|r| r.path);
```

### 2.4 Register module

In `src-tauri/src/acp/mod.rs`:
```rust
pub mod deploy;
```

---

## Files Modified

| File | Action |
|------|--------|
| `Cargo.toml` (root) | Add `xtask` to workspace members |
| `xtask/Cargo.toml` | New — xtask crate manifest |
| `xtask/src/main.rs` | New — cross-platform build script (replaces bash) |
| `src-tauri/build.rs` | Create resource stubs before `tauri_build::build()` |
| `src-tauri/tauri.conf.json` | Add `resources`, `beforeBundleCommand` |
| `src-tauri/src/acp/resolve.rs` | New — local path resolution |
| `src-tauri/src/acp/deploy.rs` | New — remote version check + SFTP deploy |
| `src-tauri/src/acp/mod.rs` | Register `resolve` + `deploy` modules |
| `src-tauri/src/acp/manager.rs` | Use `resolve_server_path` |
| `src-tauri/src/acp/rpc.rs` | Use `resolve_server_path_standalone` |
| `src-tauri/src/ipc/acp_handlers.rs` | Use resolve + deploy |
| `maestro-server/src/main.rs` | Add `--protocol-version` flag |
| `src-tauri/.gitignore` | Ignore `/resources/` entirely |

**Removed**: `scripts/build-server-binaries.sh` (replaced by xtask)

---

## Implementation Order

1. `--protocol-version` flag in maestro-server ✅ (done)
2. `resolve.rs` + replace `which` calls ✅ (done)
3. `deploy.rs` + integration ✅ (done)
4. Create `xtask` crate (replaces `scripts/build-server-binaries.sh`)
5. Update `src-tauri/build.rs` — stub creation for glob validation
6. Update `tauri.conf.json` — `beforeBundleCommand` → `cargo run -p xtask`
7. Update workspace `Cargo.toml` — add `xtask` member
8. Remove `scripts/build-server-binaries.sh`
9. Remove tracked stub files, update `.gitignore` to ignore `/resources/`

---

## Verification

1. `cargo check -p maestro` — compiles with new modules
2. `cargo check -p maestro-server` — compiles with --protocol-version flag
3. `cargo check -p xtask` — xtask compiles
4. `cargo run -p xtask` — produces files in `src-tauri/resources/`
5. `maestro-server --protocol-version` → prints `1`
6. `pnpm tauri build` — installer includes both binaries
7. Run bundled app locally — spawns server from resource dir
8. `pnpm tauri:dev` — falls back to PATH (dev mode works)
9. Connect to remote without maestro-server → auto-deploys, emits status events
10. Connect to remote with wrong version → auto-replaces
11. Connect to remote with correct version → skips deploy, uses existing
