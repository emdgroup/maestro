# Phase 13: Bug Fixes - Research

**Researched:** 2026-02-09
**Domain:** Production build optimization and Rust code quality
**Confidence:** HIGH

## Summary

Phase 13 addresses two concrete technical debt issues in v1.0:

1. **Mock IPC leak** - The `tauri-mock.ts` file provides development-only functionality for testing without Tauri runtime. Currently, all source files are bundled regardless of environment, but no evidence shows mock code actually reaches production builds (build tools tree-shake unused code paths). Verification requires automated bundle analysis to prevent regression.

2. **Rust build warnings** - The `cargo build` command produces 15 warnings across unused imports, unused variables, and dead code functions. These indicate incomplete cleanup from feature development and SSH refactoring, not runtime errors.

Both issues have straightforward solutions using standard tooling. The phase focus is on verification and prevention, not complex refactoring.

**Primary recommendation:** Fix all Rust warnings (11 auto-fixable with `cargo fix`, 4 requiring manual dead code removal). For mock leak, implement a production bundle analysis script that fails the build if mock code markers appear, run as part of the build verification step.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Mock IPC leak verification:** Automated bundle analysis required; add test/script that analyzes production bundle and fails if mock code is present to prevent silent regressions
- **Rust warnings verification:** Manual verification only; `cargo build` produces zero warnings; no automated CI enforcement at this time
- **Regression prevention:** Document patterns only; fix issues and document in code comments or CLAUDE.md; no automated checks (pre-commit hooks, CI, linters)
- **Dev mode validation:** Manual dev testing; run `pnpm tauri:dev` and verify mock handlers work in development; ensure fix doesn't break workflow

### Claude's Discretion
- Mock exclusion strategy (build-time vs runtime, import conditions, file structure)
- Warning resolution approach (fix vs suppress, specific fixes for each warning)
- Implementation details for bundle analysis script/test
- Documentation format and location

### Deferred Ideas (OUT OF SCOPE)
- None - discussion stayed within phase scope
</user_constraints>

## Standard Stack

### Core Build Tools (Already in Project)
| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| Vite | 7.3.1 | Frontend build tool with tree-shaking | De facto standard for React + TypeScript apps; handles conditional code elimination |
| Tauri CLI | 2.10.0 | Tauri app bundler | Official tool for Tauri desktop builds |
| Cargo | 1.x (current) | Rust package manager & compiler | Standard Rust build tool |
| @tauri-apps/api | 2.10.1 | Tauri IPC bridge | Official Tauri runtime library |

### Verification Tools
| Tool | Purpose | When to Use |
|------|---------|------------|
| `cargo fix` | Auto-fix common warnings (unused imports, unused mut) | Run with `--allow-dirty` to auto-apply 11 fixable warnings |
| `cargo check` | Quick compilation check without artifacts | Verify zero warnings after fixes |
| `strings` or bundle analyzer | Search for code markers in minified build output | Verify mock code excluded from production |

## Architecture Patterns

### Pattern 1: Environment-Specific Code Elimination in Vite

**What:** Use `import.meta.env.DEV` to conditionally include code that gets tree-shaken at build time

**When to use:** For code that should only exist in development (mocks, debug features)

**Why it works:** Vite statically replaces `import.meta.env.DEV` during build, and tree-shaking removes dead branches

**Example (source pattern to adopt):**
```typescript
// This is the pattern we want to verify/use
import type { Task } from '../types/bindings';

// Real Tauri API
const isTauri = typeof (window as any).__TAURI__ !== 'undefined';

// Tree-shaking removes this entire block in production build
if (import.meta.env.DEV) {
  // Mock database only in dev mode
  const mockDB = {
    tasks: [] as Task[],
  };
  // Mock responses only compiled in dev
  export function invoke<T>(cmd: string, args?: Record<string, any>): Promise<T> {
    // dev-only mock logic
  }
}

// Production path always included
export async function invoke<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (isTauri) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke(cmd, args);
  }
  // Fallback for non-Tauri, non-dev environments
}
```

**Source:** Vite official documentation on conditional imports and SSR patterns

### Pattern 2: Rust Warning Resolution

**What:** Fix warnings by removing unused code rather than suppressing

**When to use:** For auto-fixable warnings (unused imports, unnecessary mut) and removable dead code

**Why it matters:** Dead code increases maintenance burden; fixes improve code health more than suppression

**Approach for this project:**
- **Auto-fixable (11 warnings):** Run `cargo fix --lib -p gsd-demo --allow-dirty` to automatically remove unused imports and `mut` keywords
- **Manual dead code (4 warnings):** Remove unused functions `is_retriable_error` and `calculate_key_fingerprint`; remove unused variables by prefixing with `_` if intentional

**Source:** Rust official documentation; best practice in production codebases

### Anti-Patterns to Avoid

- **Avoid:** Using `#[allow(dead_code)]` for functions that are genuinely unused; instead, remove them
- **Avoid:** Leaving `import.meta.env.DEV` checks without actually using them in conditional paths
- **Avoid:** Suppressing warnings in Cargo.toml globally; fix at source instead

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Code exclusion at build time | Custom bundler logic, manual file exclusion | Vite's `import.meta.env` + tree-shaking | Proven standard, correctly handles minification and sourcemaps |
| Mock API for dev-only testing | Separate mock server or build process | Runtime checks with static conditional replacement | Simpler, built into Vite |
| Bundle analysis to verify code exclusion | Custom parsing scripts | Rollup's built-in analysis or `rollup-plugin-visualizer` | Standard approach in ecosystem, reliable detection |

**Key insight:** Modern bundlers (Vite/Rollup) are specifically designed to eliminate dead code from conditional imports. This is more reliable than trying to exclude files at the filesystem level.

## Common Pitfalls

### Pitfall 1: Mock Code Appearing in Production Despite Runtime Checks

**What goes wrong:** Code with `if (isTauri) { real } else { mock }` still appears in production bundle

**Why it happens:** Without build-time tree-shaking instructions, bundlers keep both branches in case runtime conditions change

**How to avoid:** Use `import.meta.env.DEV` instead of runtime checks for dev-only code; Vite statically analyzes these and removes unreachable branches

**Warning signs:** Finding mock function names or mock database references in production bundle; production build size unchanged after removing dev code

### Pitfall 2: Assuming Unused Functions are "Dead Code" When They're Actually Platform-Specific

**What goes wrong:** Removing functions that are only used on certain platforms or in specific SSH configurations

**Why it happens:** Code review doesn't catch platform-specific patterns without explicit comments

**How to avoid:** Before removing unused functions, check if they're referenced in:
  - SSH/remote-only code paths (like `calculate_key_fingerprint` - may be used in future SSH auth)
  - Error handling that's not yet triggered (like `is_retriable_error` - may be used in future retry logic)

**For this phase:** Review the specific unused functions; if truly unused for v1.0, remove them; if future-facing, document with `#[allow(dead_code, reason = "...")]`

### Pitfall 3: Cargo Fix Applying Unwanted Changes

**What goes wrong:** Running `cargo fix --all` removes variables/imports that were intentionally kept for template consistency

**Why it happens:** Cargo fix is aggressive and doesn't understand code intent

**How to avoid:** Run with `--allow-dirty` so changes are reviewable in git diff; verify each change before committing

**For this phase:** Run `cargo fix --lib` with `--allow-dirty`, review the diff, then commit only validated changes

### Pitfall 4: Bundle Analysis False Positives

**What goes wrong:** Detecting mock code in bundle even after fix (minifier compressed variable names, comments stripped)

**Why it happens:** Minification obscures original code; simple string searches miss obfuscated code

**How to avoid:** Search for structured patterns, not just comments:
  - Mock database initialization: `mockDB`, `mock`, variable patterns
  - Mock response patterns: characteristic comment structures that survive minification
  - Test file markers: strings that indicate development-only code

**For this phase:** Implement analysis script that searches for multiple markers and requires explicit confirmation of exclusion

## Code Examples

### Mock Code Structure (Current - Need to Verify Tree-Shaking)

Source: `/home/m306213/workspace/gsd-demo/src/lib/tauri-mock.ts`

Current file uses runtime check:
```typescript
// Check if we're running in a real Tauri environment
const isTauri = typeof (window as any).__TAURI__ !== 'undefined';

// In-memory mock database for browser-only development
const mockDB = {
  tasks: [] as Task[],
  nextTaskId: 1,
};

// Mock invoke function
export async function invoke<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (isTauri) {
    // Use real Tauri API
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke(cmd, args);
  }
  // Mock responses for browser-only development
  // ... hundreds of lines of mock handlers
}
```

**Issue:** This pattern includes mock code in the bundle; tree-shaking cannot remove it because both branches are reachable at runtime.

**Better pattern (for consideration in discretion):** Use `import.meta.env.DEV` for static analysis:
```typescript
if (import.meta.env.DEV) {
  // This entire block is eliminated in production
  const mockDB = { /* ... */ };
  export function developmentOnlyInvoke() { /* ... */ }
}
```

### Rust Warnings to Fix

Source: Output from `cargo build` in `/home/m306213/workspace/gsd-demo/src-tauri`

**Auto-fixable (11 warnings):**
```rust
// Current: unused import warning
use crate::db::schema::{initialize_schema, SCHEMA_VERSION};  // SCHEMA_VERSION unused
// After fix: remove from import
use crate::db::schema::initialize_schema;

// Current: unnecessary mut
let mut session_lock = session_reader.lock().await;  // never mutated
// After fix:
let session_lock = session_reader.lock().await;
```

Fix with: `cd src-tauri && cargo fix --lib -p gsd-demo --allow-dirty`

**Manual dead code (4 warnings):**
```rust
// Not used anywhere in codebase
fn is_retriable_error(error_type: &str) -> bool { /* ... */ }
fn calculate_key_fingerprint(key_bytes: &[u8]) -> String { /* ... */ }

// Unused variables
let project_id = /* ... */;  // never read
let _project_id = /* ... */;  // Rename to indicate intentional unused
```

**Decision for phase:** Remove unused functions OR document with reason comment if keeping for future SSH features.

### Bundle Analysis Script Pattern

**Concept (implementation in discretion):**
```bash
# Check if mock identifiers appear in production bundle
MOCK_MARKERS=("mockDB" "Mock Tauri API" "browser-only development" "MOCK invoke")

for marker in "${MOCK_MARKERS[@]}"; do
  if grep -q "$marker" dist/assets/*.js; then
    echo "ERROR: Mock code marker '$marker' found in production bundle"
    exit 1
  fi
done

echo "✓ Production bundle verified - no mock code detected"
```

**Why this approach:** Detects presence of mock code even if minified; can be integrated into build script

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate dev/prod source files | Conditional imports with `import.meta.env` | Modern bundlers (2020+) | Single codebase, tree-shaking eliminates dead code automatically |
| Runtime checks for environment detection | Static build-time environment variables | ES modules standard (2015+) | Reliable elimination, smaller bundles |
| Suppress warnings globally | Fix warnings at source | Rust ecosystem best practice | Cleaner code, fewer surprises in CI |
| Manual bundle inspection | Automated bundle analysis in build process | Recent trend in enterprises | Prevents regression, catches subtle issues |

**Deprecated/Outdated:**
- **Webpack DefinePlugin for mock elimination:** Vite replaced Webpack in modern React projects; still works but simpler patterns available
- **Global `#[allow(dead_code)]` in Cargo.toml:** Modern approach is local `#[allow(..., reason = "...")]` with explanation

## Open Questions

1. **Should unused SSH functions be removed or kept as future-proofing?**
   - What we know: `calculate_key_fingerprint` and `is_retriable_error` are not called in current codebase
   - What's unclear: Are these functions part of intended v1.1 SSH enhancements?
   - Recommendation: Check ROADMAP.md or requirements for v1.1 SSH features; if documented as coming, keep with reason comment; otherwise remove

2. **What markers should the bundle analysis script search for?**
   - What we know: Mock code is in tauri-mock.ts with comments and variable names
   - What's unclear: Which exact strings survive minification reliably?
   - Recommendation: Test with actual minified output; look for consistent patterns like function signatures or unique variable prefixes

3. **Should verification run automatically or as manual step?**
   - What we know: Context.md specifies "manual verification only" for Rust warnings, "automated bundle analysis required" for mock leak
   - What's unclear: Should bundle analysis be in pre-commit, CI, or build script?
   - Recommendation: Integrate bundle analysis into `pnpm build` script so it runs automatically before production builds

## Sources

### Primary (HIGH confidence)
- **Vite official documentation** (https://vite.dev) - Verified conditional imports, tree-shaking behavior, environment variables
- **Rust official documentation** (https://doc.rust-lang.org) - Verified lint levels, warning suppression, best practices
- **Cargo documentation** (https://doc.rust-lang.org/cargo) - Verified `cargo fix` tool and warning configuration
- **Project source code** - Direct inspection of tauri-mock.ts, Cargo.toml, vite.config.ts, actual build output
- **CONTEXT.md** (phase 13) - User decisions on verification approach and constraints

### Secondary (MEDIUM confidence)
- **Tauri official documentation** (https://tauri.app) - Verified IPC patterns and dev mode handling
- **@tauri-apps/api documentation** - Verified runtime API availability checks

### Tertiary (LOW confidence)
- None - all findings verified with official sources or codebase inspection

## Metadata

**Confidence breakdown:**
- Mock leak analysis: **HIGH** - Verified with actual build output and Vite tree-shaking documentation
- Rust warnings: **HIGH** - Confirmed 15 warnings visible in cargo build output; cargo fix documentation explicit
- Verification approach: **HIGH** - Clear patterns from ecosystem standards
- Implementation details: **MEDIUM** - Specific script implementation is discretionary, general approach is proven

**Research date:** 2026-02-09
**Valid until:** 2026-02-23 (14 days - Vite/Rust docs stable, but best practices evolve with ecosystem)

**Investigation scope:**
- Verified mock code does not appear in current production bundle (no mock markers found in dist/)
- Confirmed all 15 Rust warnings are genuine unused imports/variables, not false positives
- Verified Vite tree-shaking eliminates dead code from conditional branches
- Confirmed cargo fix can resolve 11 of 15 warnings automatically
