import { test, expect } from '@playwright/test';

test.describe('ProjectPicker Hover States', () => {
  test('Main action buttons use accent color', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    const picker = page.locator('[data-testid="project-picker"]');
    await expect(picker).toBeVisible();

    // Capture normal state
    await expect(page).toHaveScreenshot('projectpicker-normal.png');

    // Hover over Local Project button
    const localButton = page.getByRole('button', { name: /local project/i });
    await localButton.hover();
    await page.waitForTimeout(200);

    // Capture hover state
    await expect(page).toHaveScreenshot('projectpicker-hover-local.png');
  });

  test('Recent projects have subtle hover states', async ({ page }) => {
    // This test assumes there are recent projects
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    const recentSection = page.locator('text=Recent Projects');

    // Only run this test if recent projects exist
    if (await recentSection.isVisible()) {
      const firstRecentProject = page.locator('ul.list-none button').first();

      // Capture normal state
      await expect(page).toHaveScreenshot('recent-project-normal.png');

      // Hover over first recent project
      await firstRecentProject.hover();
      await page.waitForTimeout(200);

      // Capture hover state - should show border and text color change, not background
      await expect(page).toHaveScreenshot('recent-project-hover.png');
    }
  });
});
