---
phase: 22-auto-remove-stale-projects
verified: 2026-03-16T15:40:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 22: Auto-Remove Stale Projects Verification Report

**Phase Goal:** When fetching projects for a connection, automatically validate that project paths still exist and silently remove those that don't before returning the list — so the user never sees dead entries.
**Verified:** 2026-03-16T15:40:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                     | Status     | Evidence                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Local stale projects are removed from DB and absent from returned list                    | VERIFIED   | `collect_stale_project_ids` (None arm, line 108-112) filters via `Path::exists()`; matched IDs are DELETEd and filtered from return (lines 87-94) |
| 2   | SSH stale projects are removed from DB and absent from returned list                      | VERIFIED   | `collect_stale_project_ids` (Some arm, lines 115-148) runs `test -d` via `session.execute_command`; same DELETE + filter path           |
| 3   | DB mutex released before async SSH work                                                   | VERIFIED   | Scoped block (lines 71-75) acquires and drops `conn` before `collect_stale_project_ids` is awaited on line 78                           |
| 4   | SSH validation is best-effort: per-project errors keep the project                        | VERIFIED   | `Err(e)` arm in `collect_stale_project_ids` (lines 138-145) logs the error and does NOT push to `stale` vec — project is kept           |
| 5   | No frontend code changes needed                                                            | VERIFIED   | `git log defcb63..HEAD -- src/` produced no output; zero frontend files modified                                                        |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact                                         | Expected                                                 | Status   | Details                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `src-tauri/src/ipc/project_handlers.rs`          | Async `get_connection_projects` with stale cleanup logic | VERIFIED | File modified in commits defcb63 and d966509; both helpers implemented and substantive      |
| `collect_stale_project_ids` helper               | Private async helper for dual-path validation            | VERIFIED | Lines 101-150; handles None (local) and Some (SSH) branches with correct error semantics    |
| `fetch_projects_from_db` helper                  | Isolated DB fetch to ensure conn drops before async work | VERIFIED | Lines 12-42; explicit match arms avoid E0597 lifetime errors fixed in commit d966509        |

### Key Link Verification

| From                          | To                            | Via                                          | Status   | Details                                                      |
| ----------------------------- | ----------------------------- | -------------------------------------------- | -------- | ------------------------------------------------------------ |
| `get_connection_projects`     | `fetch_projects_from_db`      | Direct call inside scoped block (line 73)    | WIRED    | Scoped block ensures `conn` drops before async proceeds       |
| `get_connection_projects`     | `collect_stale_project_ids`   | `.await` call (line 78)                      | WIRED    | DB lock confirmed released before this await                 |
| `collect_stale_project_ids`   | `AppState::get_ssh_session`   | `app_state.get_ssh_session(conn_id).await`   | WIRED    | Method confirmed at `db/connection.rs:66`                    |
| SSH session                   | `execute_command`             | `session.execute_command(&cmd).await`        | WIRED    | Method confirmed at `ssh/session.rs:255`                     |
| `get_connection_projects`     | DB DELETE                     | `conn.execute("DELETE FROM projects…")`      | WIRED    | Lines 87-91; re-acquires lock only after async work is done  |

### Requirements Coverage

No `requirements:` field in plan frontmatter; phase is self-contained with must_haves listed directly in the plan. All five must_haves map 1:1 to the observable truths above and are verified.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| None | —    | —       | —        | —      |

No TODO/FIXME/placeholder comments, empty implementations, or stub return values were found in the modified file.

### Human Verification Required

None. All behaviors are verifiable through static analysis of the Rust source:

- Mutex release timing is a structural property of the scoped block (compiler-enforced).
- Error-keep semantics are expressed in the explicit `Err` arm.
- Build correctness is confirmed by `cargo build` returning `Finished` with 0 errors.

The only runtime behavior that cannot be exercised without a live environment is the actual SSH round-trip validation, but the code path is fully wired and the logic is correct.

### Build Verification

`cargo build` in `src-tauri/` completed successfully:

```
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.51s
```

Zero errors, zero warnings relevant to this change.

### Commit Trail

| Commit    | Description                                                         |
| --------- | ------------------------------------------------------------------- |
| `defcb63` | feat(phase-22): async get_connection_projects + collect_stale_ids   |
| `d966509` | fix(phase-22): resolve E0597 lifetime error in fetch_projects_from_db |

Both commits are present in `git log`. The fix commit addressed a Rust borrow-checker issue discovered after the initial implementation — the current file state (post-d966509) is the verified state.

---

_Verified: 2026-03-16T15:40:00Z_
_Verifier: Claude (gsd-verifier)_
