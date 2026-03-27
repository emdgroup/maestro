# Phase 13: Bug Fixes - Context

**Gathered:** 2026-02-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Eliminate technical debt from v1.0 by fixing two concrete bugs:
1. Mock IPC leak - tauri-mock.ts appearing in production builds
2. Rust build warnings - unused imports, dead code, etc.

This is a cleanup phase with clear pass/fail criteria. No feature additions or behavior changes.

</domain>

<decisions>
## Implementation Decisions

### Verification Approach

**Mock IPC leak verification:**
- Automated bundle analysis required
- Add test/script that analyzes production bundle and fails if mock code is present
- Prevents silent regressions in future builds

**Rust warnings verification:**
- Manual verification only
- Check that `cargo build` produces zero warnings
- No automated CI enforcement at this time

**Regression prevention:**
- Document patterns only
- Fix issues and document correct patterns in code comments or CLAUDE.md
- No automated checks (pre-commit hooks, CI, linters) for now

**Dev mode validation:**
- Manual dev testing
- Run `pnpm tauri:dev` and verify mock handlers work correctly in development
- Ensure the fix doesn't break development workflow

### Claude's Discretion
- Mock exclusion strategy (build-time vs runtime, import conditions, file structure)
- Warning resolution approach (fix vs suppress, specific fixes for each warning)
- Implementation details for bundle analysis script/test
- Documentation format and location

</decisions>

<specifics>
## Specific Ideas

- Bundle analysis should fail CI/build if mock code detected in production output
- Zero warnings is the goal for Rust build (`cargo build` must be clean)
- Development workflow must remain unchanged - mocks work in dev, excluded in prod

</specifics>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope

</deferred>

---

*Phase: 13-bug-fixes*
*Context gathered: 2026-02-09*
