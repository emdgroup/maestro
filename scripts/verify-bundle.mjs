#!/usr/bin/env node

/**
 * Automated bundle verification for mock code exclusion
 * Fails the build if mock code markers are detected in production bundle
 * Prevents regression of the mock code tree-shaking optimization
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const MOCK_MARKERS = [
  'mockDB',
  'Mock Tauri API',
  'browser-only development',
  'mock invoke',
];

const BUNDLE_DIR = path.join(process.cwd(), 'dist/assets');

console.log('Verifying production bundle for mock code...');

if (!fs.existsSync(BUNDLE_DIR)) {
  console.error('ERROR: dist/assets not found. Run pnpm build first.');
  process.exit(1);
}

const jsFiles = fs.readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.js'));
let mockCodeFound = false;

for (const marker of MOCK_MARKERS) {
  for (const file of jsFiles) {
    const filePath = path.join(BUNDLE_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes(marker)) {
      console.error(`❌ FAILED: Found mock marker "${marker}" in ${file}`);
      mockCodeFound = true;
    }
  }
}

if (mockCodeFound) {
  console.error('ERROR: Mock code detected in production bundle. Did you forget import.meta.env.DEV?');
  process.exit(1);
}

console.log('✓ PASSED: Production bundle verified - no mock code detected');
process.exit(0);
