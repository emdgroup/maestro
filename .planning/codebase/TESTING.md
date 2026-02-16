# Testing Patterns

**Analysis Date:** 2026-02-14

## Test Framework

**Runner:**
- Playwright 1.58.2
- Config: `playwright.config.ts`

**Assertion Library:**
- Playwright's built-in assertion API (`expect()`)
- HTML Reporter for test results

**Run Commands:**
```bash
pnpm test:e2e              # Run all Playwright E2E tests
pnpm test:e2e:ui          # Run Playwright tests in UI mode (interactive)
cd src-tauri && cargo test # Run Rust unit tests
```

**Backend Unit Tests:**
- Rust tests run with `cargo test`
- In-memory SQLite for database tests (`rusqlite::Connection::open_in_memory()`)
- Test modules co-located with implementation files (Rust convention)

## Test File Organization

**Frontend E2E Tests:**
- Location: `tests/e2e/` directory
- Naming: `*.spec.ts` files
- Currently 3 test suites:
  - `visual.spec.ts` - Visual regression and layout tests
  - `hover-states.spec.ts` - Interaction state validation
  - `dark-mode-visual.spec.ts` - Theme rendering tests

**Rust Unit Tests:**
- Location: Co-located in `src-tauri/src/` next to source files
- Examples:
  - `src-tauri/src/db/connection.rs` - Contains `test_init_db()`
  - `src-tauri/src/db/settings.rs` - Contains `test_load_settings_empty()` and `test_save_and_load_settings()`

## Test Structure

**E2E Test Suite Organization:**
```typescript
import { test, expect } from '@playwright/test';

test.describe('Visual Regression Tests', () => {
  test('ProjectPicker renders in light mode', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    const picker = page.locator('[data-testid="project-picker"]');
    await expect(picker).toBeVisible();

    // Capture baseline screenshot
    await expect(page).toHaveScreenshot('projectpicker-light.png');
  });
});
```

**Patterns:**
- Use `test.describe()` for grouping related tests
- Each test should be isolated and able to run independently
- Always wait for page load: `page.waitForLoadState('domcontentloaded')`
- Use small timeout delays (200-500ms) for animation settling

**Rust Test Suite Organization:**
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_init_db() {
        let test_db_path = PathBuf::from("/tmp/test-gsd-demo.db");

        // Clean up if exists
        let _ = fs::remove_file(&test_db_path);

        // Test body
        let result = init_db(test_db_path.clone());
        assert!(result.is_ok());

        // Cleanup
        let _ = fs::remove_file(&test_db_path);
    }
}
```

## Mocking

**Framework:** None (Playwright tests run against real dev server)

**Frontend Mock Approach:**
- Location: `src/lib/tauri-mock.ts`
- Used only in development mode via `import.meta.env.DEV` checks
- Provides mock Tauri IPC handlers when real Tauri is unavailable
- **Critical Pattern:** Mock code wrapped in `if (import.meta.env.DEV)` to enable tree-shaking in production

**Example Mock Guard:**
```typescript
// src/lib/tauri-mock.ts
if (import.meta.env.DEV) {
  // Mock invoke handler only available in dev
  export async function mockInvoke(cmd: string, args?: any) { ... }
}

// Usage in components
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "./lib/tauri-safe";
```

**Backend Mocking:**
- In-memory SQLite database for all Rust tests
- No external service mocking required
- Each test creates fresh in-memory database: `rusqlite::Connection::open_in_memory()`

## Fixtures and Factories

**Test Data:**
- No factory pattern currently used in E2E tests
- Test assumptions documented (e.g., "This test assumes there are recent projects")

**Rust Test Fixtures:**
```rust
#[test]
fn test_save_and_load_settings() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::initialize_schema(&conn).unwrap();

    let settings = AppSettings {
        project_path: Some("/path/to/project".to_string()),
        recent_projects: vec!["/path/to/project".to_string()],
        model_default: "claude-opus-4-5".to_string(),
        mcp_allowlist: vec!["filesystem".to_string()],
        skills_default: vec!["javascript".to_string()],
        theme_preference: Some("dark".to_string()),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };

    save_settings(&mut conn, &settings).unwrap();
    // Assertions follow
}
```

**Location:**
- Fixtures defined inline within test functions
- Schema initialized via `initialize_schema(&conn)` helper
- No external fixture files

## Coverage

**Requirements:** Not enforced

**View Coverage:** No coverage reporting configured

**Type Safety Instead:**
- TypeScript strict mode covers many potential bugs
- Rust type system prevents categories of errors
- E2E tests validate critical user paths rather than line coverage

## Test Types

**E2E Tests:**
- Scope: Full application rendering and UI interactions
- Approach: Load app at `http://localhost:5173`, validate visual output
- Tools: Playwright with visual regression screenshots
- Browser: Chromium only (Firefox/WebKit commented out in config)
- Visual regression: Baseline screenshots committed to repo

**Integration Tests:**
- Rust database tests in `src-tauri/src/`
- Scope: Database operations with in-memory SQLite
- Approach: Create fixtures, execute operation, assert state changes

**Unit Tests:**
- Rust: Specific function behavior (e.g., settings load/save)
- Frontend: No dedicated unit tests (rely on E2E for validation)

## Common Patterns

**Async Testing:**
```typescript
test('ProjectPicker renders in light mode', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  const picker = page.locator('[data-testid="project-picker"]');
  await expect(picker).toBeVisible();

  // Visual regression
  await expect(page).toHaveScreenshot('projectpicker-light.png');
});
```

**Conditional Testing:**
```typescript
test('Recent projects have subtle hover states', async ({ page }) => {
  await page.goto('/');
  const recentSection = page.locator('text=Recent Projects');

  // Only run this test if recent projects exist
  if (await recentSection.isVisible()) {
    const firstRecentProject = page.locator('ul.list-none button').first();
    await firstRecentProject.hover();
    await expect(page).toHaveScreenshot('recent-project-hover.png');
  }
});
```

**Error Testing in Rust:**
```rust
#[test]
fn test_init_db() {
    let test_db_path = PathBuf::from("/tmp/test-gsd-demo.db");

    let result = init_db(test_db_path.clone());
    assert!(result.is_ok());

    if let Ok(conn) = result {
        // Verify foreign keys are enabled
        let fk_enabled: u32 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap_or(0);
        assert_eq!(fk_enabled, 1);
    }
}
```

## Playwright Configuration

**Base URL:** `http://localhost:5173` (Vite dev server)

**Screenshot Settings:**
- Captured on failure only: `screenshot: 'only-on-failure'`
- HTML reporter shows screenshots in test results

**Trace Settings:**
- Trace collected on first retry: `trace: 'on-first-retry'`
- Enables debugging of flaky tests

**Parallel Execution:**
- Dev environment: Full parallel (default)
- CI environment: Sequential with retries (2 retries)

**Web Server:**
- Automatically starts `pnpm dev` before running tests
- Reuses existing server if available (unless CI): `reuseExistingServer: !process.env.CI`
- Timeout: 120 seconds for server startup

**Project Configuration:**
- Chromium only (production target)
- Firefox and WebKit commented out (require additional system dependencies)

## Test Data State

**Persistence:**
- Playwright tests run against real dev server with real SQLite database
- Database state persists between test runs unless manually cleared
- Tests should not depend on specific pre-existing data (use conditional checks)

**Isolation:**
- No database reset between tests
- Each E2E test re-navigates to app root
- Recent projects list can vary based on prior usage

## Known Test Gaps

**Areas Not Tested:**
- Rust IPC handlers (manual testing only)
- SSH remote connections (no mock SSH server)
- Agent execution lifecycle (requires mock Tauri shell)
- Worktree management operations

---

*Testing analysis: 2026-02-14*
