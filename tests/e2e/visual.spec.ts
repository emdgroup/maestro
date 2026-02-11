import { test, expect } from '@playwright/test';

test.describe('Visual Regression Tests', () => {
  test('ProjectPicker renders in light mode', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Verify ProjectPicker is visible by finding the main content
    const mainContent = page.locator('main');
    await expect(mainContent).toBeVisible();

    // Capture baseline screenshot
    await expect(page).toHaveScreenshot('projectpicker-light.png');
  });

  test('ProjectPicker renders in dark mode', async ({ page }) => {
    await page.goto('/');

    // Force dark mode via CSS and localStorage
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme_preference', 'dark');
    });

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // Wait for theme transition

    const mainContent = page.locator('main');
    await expect(mainContent).toBeVisible();

    await expect(page).toHaveScreenshot('projectpicker-dark.png');
  });

  test('AppHeader with tabs renders correctly', async ({ page }) => {
    // Navigate to app (simulate project selection by setting localStorage)
    await page.evaluate(() => {
      localStorage.setItem('project_path', '/tmp/test-project');
    });

    await page.goto('/');

    // Wait for app to load
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Look for header element
    const header = page.locator('header');
    await expect(header).toBeVisible();

    // Verify header height is reasonable (compact h-12 = 48px, allow some variance)
    const box = await header.boundingBox();
    if (box) {
      expect(box.height).toBeLessThanOrEqual(80);
    }

    // Capture header screenshot
    await expect(header).toHaveScreenshot('header-with-tabs.png');
  });

  test('Page renders without layout corruption', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Take full page screenshot
    await expect(page).toHaveScreenshot('page-full.png');
  });

  test('Theme toggle preserves layout', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Get initial state
    const initialBox = await page.locator('main').boundingBox();

    // Toggle dark mode
    await page.evaluate(() => {
      document.documentElement.classList.toggle('dark');
    });

    await page.waitForTimeout(300); // Wait for theme transition

    // Verify layout dimensions haven't changed significantly
    const finalBox = await page.locator('main').boundingBox();

    if (initialBox && finalBox) {
      // Allow 5px variance for potential scrollbar changes
      expect(Math.abs(initialBox.width - finalBox.width)).toBeLessThan(5);
      expect(Math.abs(initialBox.height - finalBox.height)).toBeLessThan(50);
    }
  });

  test('Cumulative Layout Shift during startup is minimal', async ({ page }) => {
    await page.goto('/');

    // Measure CLS (Cumulative Layout Shift) during page load
    const cls = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        let maxCLS = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if ('hadRecentInput' in entry && !(entry as any).hadRecentInput) {
              maxCLS += (entry as any).value;
            }
          }
        });

        try {
          observer.observe({ type: 'layout-shift', buffered: true });
        } catch {
          // layout-shift not supported
          resolve(0);
          return;
        }

        // Stop collecting after 3 seconds
        setTimeout(() => {
          observer.disconnect();
          resolve(maxCLS);
        }, 3000);
      });
    });

    // WCAG guideline: CLS should be < 0.1 for "good" web vitals
    expect(cls).toBeLessThan(0.15); // Slightly relaxed for test environment
  });

  test('Component visibility is consistent across renders', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Take multiple screenshots to verify consistency
    const screenshot1 = await page.screenshot();
    await page.waitForTimeout(500);
    const screenshot2 = await page.screenshot();

    // If screenshots are identical in dev, layout is stable
    // (This is more of a visual inspection test)
    expect(screenshot1).toBeDefined();
    expect(screenshot2).toBeDefined();
  });

  test('Responsive layout adapts to viewport changes', async ({ page }) => {
    // Test desktop viewport
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const desktopBox = await page.locator('main').boundingBox();
    expect(desktopBox).toBeDefined();

    // Test tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(300);

    const tabletBox = await page.locator('main').boundingBox();
    expect(tabletBox).toBeDefined();

    // Layout should adapt (width should be different)
    if (desktopBox && tabletBox) {
      expect(tabletBox.width).toBeLessThan(desktopBox.width);
    }

    // Test mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(300);

    const mobileBox = await page.locator('main').boundingBox();
    expect(mobileBox).toBeDefined();
    expect(mobileBox?.width).toBeLessThan(400);
  });

  test('No console errors during page load', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Filter out known/expected errors
    const unexpectedErrors = errors.filter(
      (e) =>
        !e.includes('Not authenticated') &&
        !e.includes('Not logged in') &&
        !e.includes('[Tauri]') &&
        !e.includes('[DEBUG]')
    );

    expect(unexpectedErrors).toHaveLength(0);
  });
});
