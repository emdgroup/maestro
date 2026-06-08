# Crash Prevention & Frontend Resilience Plan

## Context

Maestro can crash from Rust panics (unwrap on None/Err) and show white screens from unhandled React errors. Silent `.catch()` patterns hide failures from users. This plan addresses both dimensions.

---

## Part A: Rust Crash Prevention

### Production unwrap/expect inventory (8 locations, rest are test-only)

| # | File | Line | Expression | Severity | Fix |
|---|------|------|-----------|----------|-----|
| 1 | `acp/manager.rs` | 368 | `child.stdin.take().expect(...)` | CRITICAL | `.ok_or("stdin not piped")?` |
| 2 | `acp/manager.rs` | 369 | `child.stdout.take().expect(...)` | CRITICAL | `.ok_or("stdout not piped")?` |
| 3 | `execution/handlers.rs` | 306 | `session.unwrap()` (guarded at 303) | LOW | Replace with `.ok_or(format!(...))?` for consistency |
| 4 | `integration/token_manager.rs` | 40 | `.lock().expect("poisoned")` | HIGH | `.unwrap_or_else(\|e\| e.into_inner())` |
| 5 | `integration/token_manager.rs` | 60 | `.lock().expect("poisoned")` | HIGH | same |
| 6 | `integration/token_manager.rs` | 105 | `.lock().expect("poisoned")` | HIGH | same |
| 7 | `integration/token_manager.rs` | 130 | `.lock().expect("poisoned")` | HIGH | same |
| 8 | `integration/lookup_handlers.rs` | 612, 778 | `.expect("checked above")` | MEDIUM | `.ok_or("pagination: no next_start")?` |

**Excluded (acceptable):**
- `main.rs:60` — startup fail-fast, app can't run anyway
- `lib.rs:180` — build-time only (binding generation test)
- All `#[cfg(test)]` / `mod tests` blocks — test panics are fine

### Execution

1. Fix items 1-2 (CRITICAL) — `acp/manager.rs` subprocess handshake
2. Fix items 4-7 (HIGH) — `integration/token_manager.rs` mutex poisoning
3. Fix item 8 (MEDIUM) — `integration/lookup_handlers.rs` pagination
4. Fix item 3 (LOW) — `execution/handlers.rs` guarded unwrap

Each fix: change to `?` propagation or `unwrap_or_else`, run `cargo check`.

---

## Part B: Frontend Resilience

### B1: Add Global Error Boundary

**Problem:** No root error boundary. Any render error = white screen.

**Where:** `src/main.tsx` — wrap `<App />` in an `<ErrorBoundary>` component.

**Create:** `src/components/common/AppErrorBoundary.tsx`
- Class component (React error boundaries require class)
- Fallback UI: "Something went wrong" + reload button + error details toggle
- Log error to console for debugging

**Integration point in `main.tsx`:**
```tsx
<React.StrictMode>
  <QueryProvider>
    <ThemeProvider>
      <ToasterRoot />
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </ThemeProvider>
  </QueryProvider>
</React.StrictMode>
```

### B2: Fix Silent Error Swallowing

| # | File | Line | Pattern | Fix |
|---|------|------|---------|-----|
| 1 | `CloneProjectDialog.tsx` | 70 | `.catch(() => {})` on primeProjectServer | Add `toast.error("Failed to initialize project server")` |
| 2 | `CreateProjectDialog.tsx` | 51 | `.catch(() => {})` on primeProjectServer | Same toast |
| 3 | `Terminal.tsx` | 113 | `.catch(() => {})` on detachTerminal | OK — unmount cleanup, logging sufficient. Add `console.warn` |
| 4 | `AgentActivityPanel.tsx` | 296 | `.catch(console.error)` on setAcpConfigOption | Replace with `toast.error("Failed to save config option")` |
| 5 | `WorkingFilesPanel.tsx` | 123 | `.catch(console.error)` on CWD fetch | Set error state in component |
| 6 | `useAcpActivity.ts` | 348 | `.catch(console.error)` on drainAcpReplay | OK — background drain, console logging acceptable |
| 7 | `projectStore.ts` | 24 | `.catch(console.error)` on releaseActiveProjectLock | OK — app closing, nothing to show user |

**Action items:** Fix #1, #2, #4, #5. Leave #3, #6, #7 as-is (cleanup/teardown paths where user can't act on error).

### B3: Promise.all Listener Cleanup

Three locations create `Promise.all([listen(...), ...])` without `.catch()`:
- `src/services/connection.service.ts:242`
- `src/utils/hooks/useConnectionHealth.ts:47`
- `src/components/execution/activity/useAcpActivity.ts:327`

**Fix:** Add `.catch(console.error)` to each — listener registration failures are infrastructure bugs, not user-actionable, but must not be silent unhandled rejections.

---

## Verification

After all changes:
1. `cargo check` — no new warnings
2. `cargo test` — all pass
3. `pnpm build` — type-check + bundle pass
4. `pnpm lint` — clean
5. Manual test: kill maestro-server mid-session → app should NOT white-screen or freeze
6. Manual test: corrupt a token file → should show error toast, not crash
