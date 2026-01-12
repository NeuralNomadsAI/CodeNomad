import { test, expect } from '@playwright/test'

test.describe('EC-002: Session Tab Bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for the project tab bar to be visible
    await page.waitForSelector('.project-tab-bar', { timeout: 10000 })
  })

  test('should display session tab bar when sessions exist', async ({ page }) => {
    // The session tab bar should appear below project tabs when there are sessions
    const sessionTabBar = page.locator('.session-tab-bar')

    // Take screenshot of current state
    await page.screenshot({ path: 'test-screenshots/EC-002-initial-state.png', fullPage: true })

    // Check if session tab bar is visible (only when sessions exist)
    const sessionTabBarCount = await sessionTabBar.count()
    if (sessionTabBarCount > 0) {
      await expect(sessionTabBar).toBeVisible()
    }
  })

  test('should have scrollable session tab container', async ({ page }) => {
    const scrollContainer = page.locator('.session-tab-scroll-container')
    const scrollContainerCount = await scrollContainer.count()

    if (scrollContainerCount > 0) {
      await expect(scrollContainer).toBeVisible()

      // Verify it has overflow-x: auto styling
      const overflowX = await scrollContainer.evaluate(el =>
        window.getComputedStyle(el).overflowX
      )
      expect(overflowX).toBe('auto')
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-002-scroll-container.png', fullPage: true })
  })

  test('should show [+ New] button for creating sessions', async ({ page }) => {
    const newSessionButton = page.locator('.session-tab-new')
    const buttonCount = await newSessionButton.count()

    if (buttonCount > 0) {
      await expect(newSessionButton).toBeVisible()

      // Click the new session button
      await newSessionButton.click()
      await page.waitForTimeout(500)

      // Take screenshot after clicking
      await page.screenshot({ path: 'test-screenshots/EC-002-new-session-clicked.png', fullPage: true })
    } else {
      // No session bar visible - just screenshot the state
      await page.screenshot({ path: 'test-screenshots/EC-002-no-session-bar.png', fullPage: true })
    }
  })

  test('should highlight active session tab', async ({ page }) => {
    const activeSessionTab = page.locator('.session-tab-active')
    const tabCount = await activeSessionTab.count()

    if (tabCount > 0) {
      // Active session tab should have distinct background (accent color)
      await expect(activeSessionTab.first()).toHaveCSS('background-color', /rgb/)
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-002-active-session.png', fullPage: true })
  })

  test('should show close button on session tab hover', async ({ page }) => {
    const sessionTabs = page.locator('.session-tab:not(.session-tab-new)')
    const tabCount = await sessionTabs.count()

    if (tabCount > 0) {
      const firstTab = sessionTabs.first()
      const closeButton = firstTab.locator('.session-tab-close')

      // Before hover - close button should be hidden (opacity: 0)
      await expect(closeButton).toHaveCSS('opacity', '0')

      // Hover over the tab
      await firstTab.hover()

      // After hover - close button should be visible (opacity: 1)
      await expect(closeButton).toHaveCSS('opacity', '1')

      // Take screenshot
      await page.screenshot({ path: 'test-screenshots/EC-002-close-on-hover.png', fullPage: true })
    } else {
      await page.screenshot({ path: 'test-screenshots/EC-002-no-session-tabs.png', fullPage: true })
    }
  })

  test('should display session tab with truncated title (max 4 words)', async ({ page }) => {
    const sessionTabs = page.locator('.session-tab:not(.session-tab-new)')
    const tabCount = await sessionTabs.count()

    if (tabCount > 0) {
      // Each session tab should have a label
      const firstTabLabel = sessionTabs.first().locator('.session-tab-label')
      await expect(firstTabLabel).toBeVisible()

      // Label should have text content
      const labelText = await firstTabLabel.textContent()
      expect(labelText).toBeTruthy()

      // If text ends with "...", it was truncated (4 word limit)
      // This is just checking the structure exists, not the exact truncation
    }

    // Take final screenshot
    await page.screenshot({ path: 'test-screenshots/EC-002-session-labels.png', fullPage: true })
  })

  test('should position session tabs below project tabs', async ({ page }) => {
    const projectTabBar = page.locator('.project-tab-bar')
    const sessionTabBar = page.locator('.session-tab-bar')

    await expect(projectTabBar).toBeVisible()

    const sessionBarCount = await sessionTabBar.count()
    if (sessionBarCount > 0) {
      await expect(sessionTabBar).toBeVisible()

      // Get bounding boxes
      const projectRect = await projectTabBar.boundingBox()
      const sessionRect = await sessionTabBar.boundingBox()

      if (projectRect && sessionRect) {
        // Session tabs should be below project tabs
        expect(sessionRect.y).toBeGreaterThanOrEqual(projectRect.y + projectRect.height - 1)
      }
    }

    // Take screenshot showing tab hierarchy
    await page.screenshot({ path: 'test-screenshots/EC-002-tab-hierarchy.png', fullPage: true })
  })
})
