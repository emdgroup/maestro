import { test } from "@playwright/test";

test.describe("Dark mode screenshots", () => {
  test("capture dark mode", async ({ page }) => {
    // Navigate to app
    await page.goto("http://localhost:5173");

    // Add dark class to html element
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
    });

    // Wait for styles to apply
    await page.waitForTimeout(500);

    // Take screenshot
    await page.screenshot({
      path: "tests/screenshots/dark-mode.png",
      fullPage: false,
    });
  });

  test("capture light mode", async ({ page }) => {
    await page.goto("http://localhost:5173");
    await page.waitForTimeout(500);
    await page.screenshot({
      path: "tests/screenshots/light-mode.png",
      fullPage: false,
    });
  });
});
