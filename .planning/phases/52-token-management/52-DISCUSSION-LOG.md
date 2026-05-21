# Phase 52: Token Management — Discussion Log

**Date:** 2026-05-21
**Duration:** ~5 min
**Areas discussed:** 3/3

---

## Area 1: Token Value Shape

**Question:** Raw access token string vs. serialized JSON struct?

**Options presented:**
- A) Raw access token string only
- B) Serialized JSON struct `{ access_token, refresh_token?, expires_at?, provider }`

**User selected:** B

**Notes:** Expiry info needed for Phase 53/54 proactive refresh. Struct serialized as JSON into the keyring value.

---

## Area 2: Linux/WSL Fallback File Location

**Question:** `.maestro/tokens.enc` (project dir) vs. `appLocalDataDir/tokens/{project_id}.enc` (machine-local)?

**Options presented:**
- A) `.maestro/tokens.enc` — project-scoped, gitignored
- B) `appLocalDataDir/tokens/{project_id}.enc` — machine-local, no git concern

**User selected:** B

**Notes:** Machine-local avoids any risk of token file appearing in project dir or being accidentally committed.

---

## Area 3: TokenManager Scope

**Question:** Per-project mutex map vs. single global mutex?

**Options presented:**
- A) `TokenManager { tokens: HashMap<project_id, Mutex<TokenState>> }` — per-project mutex
- B) Single `Mutex<HashMap<project_id, TokenState>>` — simpler, serializes all projects

**User selected:** A

**Notes:** Per-project mutex allows independent concurrent refreshes across projects. Small overhead for large correctness gain.
