#!/usr/bin/env npx playwright test

import { test, expect } from '@playwright/test';

const SCREENSHOTS_DIR = '/Users/alexanderollman/CodeNomad/test-screenshots';
const TEST_PROJECT_DIR = '/Users/alexanderollman/test-threejs-project';

test('CodeNomad Three.js project creation', async ({ page }) => {
  // Navigate to CodeNomad
  await page.goto('http://localhost:9898');
  await page.waitForLoadState('networkidle');

  await page.screenshot({ path: `${SCREENSHOTS_DIR}/01-initial-load.png`, fullPage: true });

  // Wait for folder selection UI
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/02-folder-selection.png`, fullPage: true });

  // Look for path input or browse
  const pathInput = await page.$('input');
  if (pathInput) {
    await pathInput.fill(TEST_PROJECT_DIR);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/03-path-entered.png`, fullPage: true });
  }

  // Submit
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/04-workspace-loaded.png`, fullPage: true });
});
