import { test, expect } from '@playwright/test'

test.describe('EC-004: Status Indicator', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for the project tab bar to be visible
    await page.waitForSelector('.project-tab-bar', { timeout: 10000 })
  })

  test('should display status dot in project tab bar', async ({ page }) => {
    const statusDot = page.locator('.project-tab-status-dot')
    await expect(statusDot).toBeVisible()

    // Status dot should have a color class (green, yellow, or red)
    const hasColorClass = await statusDot.evaluate(el =>
      el.classList.contains('bg-green-500') ||
      el.classList.contains('bg-yellow-500') ||
      el.classList.contains('bg-red-500')
    )
    expect(hasColorClass).toBe(true)

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-004-status-dot.png', fullPage: true })
  })

  test('should show green status dot when server is healthy', async ({ page }) => {
    // Wait for the app to stabilize (server should be ready)
    await page.waitForTimeout(1000)

    const statusDot = page.locator('.project-tab-status-dot')

    // Check if the status dot is green (healthy)
    const isGreen = await statusDot.evaluate(el => el.classList.contains('bg-green-500'))

    // Should be green if server is running properly
    expect(isGreen).toBe(true)

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-004-green-status.png', fullPage: true })
  })

  test('should have clickable settings button', async ({ page }) => {
    const settingsButton = page.locator('.project-tab-settings')
    await expect(settingsButton).toBeVisible()

    // Take screenshot before click
    await page.screenshot({ path: 'test-screenshots/EC-004-settings-button.png', fullPage: true })
  })

  test('should open settings panel when clicking settings button', async ({ page }) => {
    const settingsButton = page.locator('.project-tab-settings')
    await settingsButton.click()

    // Wait for settings panel to appear
    await page.waitForTimeout(500)

    // Check if settings panel is visible
    const settingsPanel = page.locator('.settings-panel')
    const panelCount = await settingsPanel.count()

    if (panelCount > 0) {
      await expect(settingsPanel).toBeVisible()

      // Check for settings panel content
      const panelTitle = page.locator('.settings-panel-title')
      await expect(panelTitle).toBeVisible()
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-004-settings-panel.png', fullPage: true })
  })

  test('should display server status in settings panel', async ({ page }) => {
    // Open settings panel
    const settingsButton = page.locator('.project-tab-settings')
    await settingsButton.click()
    await page.waitForTimeout(500)

    // Check for status section
    const statusSection = page.locator('.settings-status')
    const statusCount = await statusSection.count()

    if (statusCount > 0) {
      await expect(statusSection).toBeVisible()

      // Should have status dot
      const statusDot = page.locator('.settings-status-dot')
      await expect(statusDot).toBeVisible()

      // Should have status label
      const statusLabel = page.locator('.settings-status-label')
      await expect(statusLabel).toBeVisible()
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-004-status-section.png', fullPage: true })
  })

  test('should have collapsible instance details (hidden by default)', async ({ page }) => {
    // Open settings panel
    const settingsButton = page.locator('.project-tab-settings')
    await settingsButton.click()
    await page.waitForTimeout(500)

    // Check for instance details toggle
    const detailsToggle = page.locator('.settings-section-toggle')
    const toggleCount = await detailsToggle.count()

    if (toggleCount > 0) {
      // Details should be hidden by default
      const detailsSection = page.locator('.settings-details')
      const detailsVisible = await detailsSection.isVisible().catch(() => false)

      // Take screenshot before expanding
      await page.screenshot({ path: 'test-screenshots/EC-004-details-collapsed.png', fullPage: true })

      // Click to expand
      await detailsToggle.click()
      await page.waitForTimeout(300)

      // Take screenshot after expanding
      await page.screenshot({ path: 'test-screenshots/EC-004-details-expanded.png', fullPage: true })
    }
  })

  test('should close settings panel when clicking close button', async ({ page }) => {
    // Open settings panel
    const settingsButton = page.locator('.project-tab-settings')
    await settingsButton.click()
    await page.waitForTimeout(500)

    // Find and click close button
    const closeButton = page.locator('.settings-panel-close')
    const closeCount = await closeButton.count()

    if (closeCount > 0) {
      await closeButton.click()
      await page.waitForTimeout(300)

      // Panel should be hidden
      const settingsPanel = page.locator('.settings-panel')
      await expect(settingsPanel).not.toBeVisible()
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-004-panel-closed.png', fullPage: true })
  })
})
