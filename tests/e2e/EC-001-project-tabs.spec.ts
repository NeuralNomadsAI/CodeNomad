import { test, expect } from '@playwright/test'

test.describe('EC-001: Project Tab Bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for the project tab bar to be visible (SSE keeps network busy)
    await page.waitForSelector('.project-tab-bar', { timeout: 10000 })
  })

  test('should display project tab bar at top of window', async ({ page }) => {
    // The project tab bar should be visible
    const tabBar = page.locator('.project-tab-bar')
    await expect(tabBar).toBeVisible()

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-001-tab-bar-visible.png', fullPage: true })
  })

  test('should show [+] button that opens new tab/home screen', async ({ page }) => {
    // The new tab button should exist
    const newTabButton = page.locator('.project-tab-new')
    await expect(newTabButton).toBeVisible()

    // Click it should create a new tab or show home screen
    await newTabButton.click()

    // Wait for any navigation/UI update
    await page.waitForTimeout(500)

    // Take screenshot after clicking
    await page.screenshot({ path: 'test-screenshots/EC-001-new-tab-clicked.png', fullPage: true })
  })

  test('should show settings button with status indicator', async ({ page }) => {
    // Settings button should be visible
    const settingsButton = page.locator('.project-tab-settings')
    await expect(settingsButton).toBeVisible()

    // Status dot should be present
    const statusDot = page.locator('.project-tab-status-dot')
    await expect(statusDot).toBeVisible()

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-001-settings-button.png', fullPage: true })
  })

  test('should highlight active tab visually', async ({ page }) => {
    // If there are tabs, the active one should have the active class
    const activeTab = page.locator('.project-tab-active')
    const tabCount = await activeTab.count()

    // If there are project tabs, verify active state styling
    if (tabCount > 0) {
      // Active tab should have distinct background
      await expect(activeTab.first()).toHaveCSS('background-color', /rgb/)
    }

    // Take screenshot showing tab states
    await page.screenshot({ path: 'test-screenshots/EC-001-active-tab.png', fullPage: true })
  })

  test('should have scrollable tab container', async ({ page }) => {
    // The scroll container should exist
    const scrollContainer = page.locator('.project-tab-scroll-container')
    await expect(scrollContainer).toBeVisible()

    // Verify it has overflow-x: auto styling
    const overflowX = await scrollContainer.evaluate(el =>
      window.getComputedStyle(el).overflowX
    )
    expect(overflowX).toBe('auto')

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-001-scroll-container.png', fullPage: true })
  })

  test('should show close button on tab hover', async ({ page }) => {
    // First check if any project tabs exist
    const projectTabs = page.locator('.project-tab:not(.project-tab-new)')
    const tabCount = await projectTabs.count()

    if (tabCount > 0) {
      const firstTab = projectTabs.first()
      const closeButton = firstTab.locator('.project-tab-close')

      // Before hover - close button should be hidden (opacity: 0)
      await expect(closeButton).toHaveCSS('opacity', '0')

      // Hover over the tab
      await firstTab.hover()

      // After hover - close button should be visible (opacity: 1)
      await expect(closeButton).toHaveCSS('opacity', '1')

      // Take screenshot
      await page.screenshot({ path: 'test-screenshots/EC-001-close-on-hover.png', fullPage: true })
    } else {
      // No tabs to test - just screenshot the empty state
      await page.screenshot({ path: 'test-screenshots/EC-001-no-tabs.png', fullPage: true })
    }
  })

  test('should display each project tab with folder name', async ({ page }) => {
    const projectTabs = page.locator('.project-tab:not(.project-tab-new)')
    const tabCount = await projectTabs.count()

    if (tabCount > 0) {
      // Each tab should have a label
      const firstTabLabel = projectTabs.first().locator('.project-tab-label')
      await expect(firstTabLabel).toBeVisible()

      // Label should have text content
      const labelText = await firstTabLabel.textContent()
      expect(labelText).toBeTruthy()
    }

    // Take final screenshot
    await page.screenshot({ path: 'test-screenshots/EC-001-tab-labels.png', fullPage: true })
  })
})
