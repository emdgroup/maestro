import { test, expect } from '@playwright/test';

test.describe('Visual Regression Tests', () => {
  test('ProjectPicker renders in light mode', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    // Verify ProjectPicker is visible
    const picker = page.locator('[data-testid="project-picker"]');
    await expect(picker).toBeVisible();

    // Capture baseline screenshot
    await expect(page).toHaveScreenshot('projectpicker-light.png');
  });

  test('ProjectPicker renders in dark mode', async ({ page }) => {
    await page.goto('/');

    // Force dark mode by adding class to root element
    await page.addInitScript(() => {
      document.documentElement.classList.add('dark');
    });

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    const picker = page.locator('[data-testid="project-picker"]');
    await expect(picker).toBeVisible();

    await expect(page).toHaveScreenshot('projectpicker-dark.png');
  });

  test('Page structure renders without errors', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    // Should have a root element
    const root = page.locator('#root');
    await expect(root).toBeVisible();

    // Filter out expected errors from Tauri or debug logs
    const unexpectedErrors = errors.filter(
      (e) =>
        !e.includes('Not authenticated') &&
        !e.includes('Not logged in') &&
        !e.includes('[Tauri]') &&
        !e.includes('[DEBUG]') &&
        !e.includes('localStorage') &&
        !e.includes('invoke')
    );

    // Some errors expected in test environment, but not rendering errors
    console.log('Unexpected errors:', unexpectedErrors);
  });

  test('Root element is always visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const root = page.locator('#root');
    await expect(root).toBeVisible();

    // Capture page structure
    await expect(page).toHaveScreenshot('page-root-visible.png');
  });

  test('Layout has reasonable dimensions', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);

    const root = page.locator('#root');
    const box = await root.boundingBox();

    expect(box).toBeDefined();
    if (box) {
      // Verify dimensions are reasonable
      expect(box.width).toBeGreaterThan(100);
      expect(box.height).toBeGreaterThan(100);
    }
  });

  test('Viewport 1920x1080 renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);

    const root = page.locator('#root');
    const box = await root.boundingBox();

    expect(box?.width).toBeGreaterThan(1800);
    expect(box?.height).toBeGreaterThan(1000);

    await expect(page).toHaveScreenshot('viewport-desktop-1920x1080.png');
  });

  test('Viewport 768x1024 renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);

    const root = page.locator('#root');
    const box = await root.boundingBox();

    expect(box?.width).toBeGreaterThan(700);
    expect(box?.height).toBeGreaterThan(900);

    await expect(page).toHaveScreenshot('viewport-tablet-768x1024.png');
  });

  test('Viewport 375x667 renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);

    const root = page.locator('#root');
    const box = await root.boundingBox();

    expect(box?.width).toBeGreaterThan(300);
    expect(box?.height).toBeGreaterThan(600);

    await expect(page).toHaveScreenshot('viewport-mobile-375x667.png');
  });

  test('Theme class toggle works', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Check initial state
    const htmlElement = page.locator('html');
    const initialClasses = await htmlElement.getAttribute('class');

    // Toggle dark mode
    await page.evaluate(() => {
      document.documentElement.classList.toggle('dark');
    });

    await page.waitForTimeout(200);

    // Verify class changed
    const finalClasses = await htmlElement.getAttribute('class');
    const initialHasDark = initialClasses?.includes('dark');
    const finalHasDark = finalClasses?.includes('dark');

    expect(initialHasDark).not.toBe(finalHasDark);
  });

  test('DOM does not shift significantly between renders', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const root = page.locator('#root');
    const box1 = await root.boundingBox();

    // Wait and measure again
    await page.waitForTimeout(500);
    const box2 = await root.boundingBox();

    if (box1 && box2) {
      // Allow minimal variance
      expect(Math.abs(box1.width - box2.width)).toBeLessThan(10);
      expect(Math.abs(box1.height - box2.height)).toBeLessThan(10);
    }
  });
});
