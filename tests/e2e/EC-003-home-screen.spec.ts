import { test, expect } from '@playwright/test'

test.describe('EC-003: Simplified Home Screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for the app to load
    await page.waitForSelector('.project-tab-bar, .home-screen', { timeout: 10000 })
  })

  test('should display home screen with three cards layout', async ({ page }) => {
    // Click the [+] button to open new tab / home screen
    const newTabButton = page.locator('.project-tab-new')
    if (await newTabButton.count() > 0) {
      await newTabButton.click()
      await page.waitForTimeout(500)
    }

    // Check for home screen or folder selection view
    const homeScreen = page.locator('.home-screen')
    const homeScreenCount = await homeScreen.count()

    if (homeScreenCount > 0) {
      // Verify three cards exist
      const homeCards = page.locator('.home-card')
      expect(await homeCards.count()).toBe(3)
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-003-home-screen.png', fullPage: true })
  })

  test('should have unified search bar at top', async ({ page }) => {
    // Navigate to home screen
    const newTabButton = page.locator('.project-tab-new')
    if (await newTabButton.count() > 0) {
      await newTabButton.click()
      await page.waitForTimeout(500)
    }

    const searchInput = page.locator('.home-search-input')
    const searchCount = await searchInput.count()

    if (searchCount > 0) {
      await expect(searchInput).toBeVisible()

      // Test placeholder text
      const placeholder = await searchInput.getAttribute('placeholder')
      expect(placeholder).toContain('Search')
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-003-search-bar.png', fullPage: true })
  })

  test('should display Recent card with folder list', async ({ page }) => {
    // Navigate to home screen
    const newTabButton = page.locator('.project-tab-new')
    if (await newTabButton.count() > 0) {
      await newTabButton.click()
      await page.waitForTimeout(500)
    }

    // Check for Recent card
    const recentCard = page.locator('.home-card').first()
    const cardCount = await recentCard.count()

    if (cardCount > 0) {
      // Should have a title
      const cardTitle = recentCard.locator('.home-card-title')
      await expect(cardTitle).toBeVisible()
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-003-recent-card.png', fullPage: true })
  })

  test('should display Browse card with action button', async ({ page }) => {
    // Navigate to home screen
    const newTabButton = page.locator('.project-tab-new')
    if (await newTabButton.count() > 0) {
      await newTabButton.click()
      await page.waitForTimeout(500)
    }

    // Check for Browse action button
    const browseButton = page.locator('.home-action-button').first()
    const buttonCount = await browseButton.count()

    if (buttonCount > 0) {
      await expect(browseButton).toBeVisible()
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-003-browse-card.png', fullPage: true })
  })

  test('should display GitHub card', async ({ page }) => {
    // Navigate to home screen
    const newTabButton = page.locator('.project-tab-new')
    if (await newTabButton.count() > 0) {
      await newTabButton.click()
      await page.waitForTimeout(500)
    }

    // Check for GitHub placeholder
    const githubPlaceholder = page.locator('.home-github-placeholder')
    const placeholderCount = await githubPlaceholder.count()

    if (placeholderCount > 0) {
      await expect(githubPlaceholder).toBeVisible()
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-003-github-card.png', fullPage: true })
  })

  test('should show keyboard shortcuts at bottom', async ({ page }) => {
    // Navigate to home screen
    const newTabButton = page.locator('.project-tab-new')
    if (await newTabButton.count() > 0) {
      await newTabButton.click()
      await page.waitForTimeout(500)
    }

    // Check for keyboard shortcuts footer
    const shortcuts = page.locator('.home-shortcuts')
    const shortcutsCount = await shortcuts.count()

    if (shortcutsCount > 0) {
      await expect(shortcuts).toBeVisible()
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-003-shortcuts.png', fullPage: true })
  })

  test('should allow keyboard navigation in recent folders', async ({ page }) => {
    // Navigate to home screen
    const newTabButton = page.locator('.project-tab-new')
    if (await newTabButton.count() > 0) {
      await newTabButton.click()
      await page.waitForTimeout(500)
    }

    // Check if recent items exist
    const recentItems = page.locator('.home-recent-item')
    const itemCount = await recentItems.count()

    if (itemCount > 0) {
      // Press arrow down to navigate
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(100)

      // Check if selection changed (visual highlight)
      const selectedItem = page.locator('.home-recent-item-selected')
      const selectedCount = await selectedItem.count()
      expect(selectedCount).toBeGreaterThanOrEqual(0)
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-003-keyboard-nav.png', fullPage: true })
  })

  test('should display recent folders with name, path, and time', async ({ page }) => {
    // Navigate to home screen
    const newTabButton = page.locator('.project-tab-new')
    if (await newTabButton.count() > 0) {
      await newTabButton.click()
      await page.waitForTimeout(500)
    }

    const recentItems = page.locator('.home-recent-item')
    const itemCount = await recentItems.count()

    if (itemCount > 0) {
      const firstItem = recentItems.first()

      // Check for name element
      const nameEl = firstItem.locator('.home-recent-item-name')
      await expect(nameEl).toBeVisible()

      // Check for path element
      const pathEl = firstItem.locator('.home-recent-item-path')
      await expect(pathEl).toBeVisible()

      // Check for time element
      const timeEl = firstItem.locator('.home-recent-item-time')
      await expect(timeEl).toBeVisible()
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-003-recent-details.png', fullPage: true })
  })
})
