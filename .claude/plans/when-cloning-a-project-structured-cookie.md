# Fix: Bitbucket Server/Cloud clone fails — inject auth into git clone

## Context

When cloning via Bitbucket Server provider, git gets an HTTPS URL but has no credentials to authenticate.

First attempt used URL-embedded credentials (`x-token-auth:{token}@host`) but Bitbucket Server rejects `x-token-auth` as username. Error: `fatal: Authentication failed`.

**Solution**: Use `git -c http.extraHeader="Authorization: Bearer <token>"` which matches how API calls authenticate (repo listing already works with Bearer token).

## Design Decision

Use git's `http.extraHeader` config to pass auth header at clone time. This:
1. Matches the exact auth mechanism used for API calls (proven to work)
2. Avoids URL encoding issues with tokens containing special chars
3. Avoids guessing username format per provider
4. Works for both local and SSH-remote clone scenarios

## Changes

### 1. Replace `inject_provider_credentials` with `build_auth_header`

**File: `src-tauri/src/ipc/project_handlers.rs`**

Replace URL credential injection with auth header builder. Return `Option<String>` (the header value) when provider is set:

```rust
fn build_provider_auth_header(
    provider: &str,
    app_state: &AppState,
) -> Result<Option<String>, String> {
    let creds = crate::ipc::issue_tracking_handlers::get_integration_creds(provider, app_state)?;

    let header = match provider {
        "bitbucket" => match creds.instance_url {
            Some(_) => format!("Authorization: Bearer {}", creds.token),
            None => {
                let email = creds.email.ok_or("Bitbucket Cloud credentials missing email")?;
                let basic = base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{}", email, creds.token).as_bytes());
                format!("Authorization: Basic {}", basic)
            }
        },
        "github" | "gitlab" | "forgejo" | "gitea" => {
            format!("Authorization: Bearer {}", creds.token)
        }
        "azuredevops" => {
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!(":{}", creds.token).as_bytes());
            format!("Authorization: Basic {}", basic)
        }
        _ => return Ok(None),
    };

    Ok(Some(header))
}
```

### 2. Update `clone_project` to use `http.extraHeader`

Pass `-c http.extraHeader=<header>` to git clone command. Both local and SSH paths:

**Local clone:**
```rust
let mut args = Vec::new();
if let Some(header) = &auth_header {
    args.extend(["-c", &format!("http.extraHeader={}", header)]);
}
args.extend(["clone", &url, &target_path]);

tokio::process::Command::new("git")
    .args(&args)
    ...
```

**SSH remote clone:**
```rust
let git_cmd = match &auth_header {
    Some(header) => format!(
        "git -c {} clone {} {}",
        shell_quote(&format!("http.extraHeader={}", header)),
        shell_quote(&url),
        shell_quote(&target_path),
    ),
    None => format!("git clone {} {}", shell_quote(&url), shell_quote(&target_path)),
};
session.execute_command(&git_cmd).await...
```

### 3. Frontend changes (already done in previous session)

- `ProviderRepoPicker.tsx` — wraps `onRepoSelected` in `ProviderForm` to inject provider key ✓
- `CloneProjectDialog.tsx` — tracks `provider` state, passes to mutation ✓
- `project.service.ts` — accepts `provider` param ✓
- `bindings.ts` — already regenerated with `provider: string | null` ✓

## Files to modify

| File | Change |
|------|--------|
| `src-tauri/src/ipc/project_handlers.rs` | Replace `inject_provider_credentials` with `build_provider_auth_header`, update both clone paths |

## Verification

1. `cargo check` — compiles
2. `pnpm build` — still passes (no frontend changes)
3. Manual test: clone Bitbucket Server repo — should succeed with Bearer token auth
4. Manual test: clone via plain URL tab (no provider) — still works (no header injected)
