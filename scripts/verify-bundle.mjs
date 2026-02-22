#!/usr/bin/env node

/**
 * Automated bundle verification for mock code exclusion and CSS coverage
 * Fails the build if:
 * 1. Mock code markers are detected in production bundle
 * 2. Critical CSS classes are purged from the bundle
 * Prevents regression of the mock code tree-shaking optimization and CSS coverage
 */

import fs from "fs";
import path from "path";

const MOCK_MARKERS = ["mockDB", "Mock Tauri API", "browser-only development", "mock invoke"];

const ESSENTIAL_CLASSES = [
  "grid-cols-5",
  "gap-4",
  "bg-background",
  "border-ring",
  "text-sm",
  "rounded-lg",
  "shadow-md",
  "animate-pulse",
  "flex",
  "flex-col",
  "absolute",
  "relative",
];

const BUNDLE_DIR = path.join(process.cwd(), "dist/assets");

console.log("Verifying production bundle for mock code and CSS coverage...");

if (!fs.existsSync(BUNDLE_DIR)) {
  console.error("ERROR: dist/assets not found. Run pnpm build first.");
  process.exit(1);
}

const jsFiles = fs.readdirSync(BUNDLE_DIR).filter((f) => f.endsWith(".js"));
const cssFiles = fs.readdirSync(BUNDLE_DIR).filter((f) => f.endsWith(".css"));

// Step 1: Check for mock code
console.log("\n--- Mock Code Verification ---");
let mockCodeFound = false;

for (const marker of MOCK_MARKERS) {
  for (const file of jsFiles) {
    const filePath = path.join(BUNDLE_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.includes(marker)) {
      console.error(`❌ FAILED: Found mock marker "${marker}" in ${file}`);
      mockCodeFound = true;
    }
  }
}

if (mockCodeFound) {
  console.error(
    "ERROR: Mock code detected in production bundle. Did you forget import.meta.env.DEV?",
  );
  process.exit(1);
}
console.log("✓ Mock code check passed");

// Step 2: Check CSS coverage
console.log("\n--- CSS Coverage Verification ---");
let cssPurgingDetected = false;

// Concatenate all CSS files for verification
let allCssContent = "";
for (const cssFile of cssFiles) {
  const cssPath = path.join(BUNDLE_DIR, cssFile);
  allCssContent += fs.readFileSync(cssPath, "utf-8");
}

for (const cls of ESSENTIAL_CLASSES) {
  if (!allCssContent.includes(cls)) {
    console.error(`❌ CSS PURGING DETECTED: class "${cls}" not found in bundle`);
    cssPurgingDetected = true;
  }
}

if (cssPurgingDetected) {
  console.error(
    "\nERROR: CSS purging detected. Critical Tailwind classes are missing from the bundle.",
  );
  process.exit(1);
}

console.log(`✓ CSS coverage check passed (${ESSENTIAL_CLASSES.length} essential classes verified)`);

console.log("\n✓ PASSED: Production bundle verified (CSS coverage OK, no mock code)");
process.exit(0);
