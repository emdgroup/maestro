# Plan: Auto-update ACP registry at build time

## Context

`maestro-server` bundles `src/assets/registry.json` via `include_str!()` at compile time. Currently this file must be manually fetched from `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`. Goal: auto-fetch at build time, overwriting the checked-in file so it also serves as updated fallback for offline builds.

## Changes

### 1. Create `maestro-server/build.rs`

Build script that:
- Fetches `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` using `ureq` (blocking HTTP, no async needed in build scripts)
- On success: overwrites `src/assets/registry.json` with fetched content
- On failure (network error, timeout, non-200): prints cargo warning, leaves existing file untouched
- Sets `cargo:rerun-if-changed=build.rs` (avoid re-running on every build — only when build.rs itself changes)
- Short timeout (5s) so builds don't hang

```rust
// maestro-server/build.rs
use std::fs;
use std::path::Path;

const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_PATH: &str = "src/assets/registry.json";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let agent = ureq::Agent::new_with_config(
        ureq::Config {
            timeout_global: Some(std::time::Duration::from_secs(5)),
            ..Default::default()
        },
    );

    match agent.get(REGISTRY_URL).call() {
        Ok(response) => {
            match response.body_mut().read_to_string() {
                Ok(body) => {
                    // Validate it's parseable JSON before overwriting
                    if serde_json::from_str::<serde_json::Value>(&body).is_ok() {
                        let path = Path::new(REGISTRY_PATH);
                        if let Err(e) = fs::write(path, &body) {
                            println!("cargo:warning=Failed to write registry.json: {e}");
                        }
                    } else {
                        println!("cargo:warning=CDN returned invalid JSON, keeping existing registry.json");
                    }
                }
                Err(e) => {
                    println!("cargo:warning=Failed to read registry response body: {e}");
                }
            }
        }
        Err(e) => {
            println!("cargo:warning=Failed to fetch ACP registry (using bundled fallback): {e}");
        }
    }
}
```

### 2. Update `maestro-server/Cargo.toml`

Add build dependencies:

```toml
[build-dependencies]
ureq = "3"
serde_json = "1"
```

`serde_json` already in regular deps, but build scripts have separate dep resolution. `ureq` is lightweight blocking HTTP — ideal for build scripts (no tokio needed).

### 3. No changes to `registry.rs`

`include_str!("assets/registry.json")` still works — it reads from `src/assets/registry.json` which is either freshly fetched or the existing fallback.

## Files to modify

- `maestro-server/Cargo.toml` — add `[build-dependencies]`
- `maestro-server/build.rs` — create (new file)

## Verification

1. `cd maestro-server && cargo build` — should see no warnings when CDN reachable
2. Check `src/assets/registry.json` has updated timestamp
3. Disconnect network, `cargo build` again — should see warning but build succeeds using existing file
4. `cargo test` still passes
