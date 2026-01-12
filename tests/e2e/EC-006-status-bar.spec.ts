import { test, expect } from '@playwright/test'

test.describe('EC-006: Status Bar - Home Screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for the app to load (either home screen or project tab bar)
    await page.waitForSelector('.home-screen, .project-tab-bar', { timeout: 15000 })
  })

  test('should not show bottom status bar on home screen (no instances)', async ({ page }) => {
    // Check if we're on the home screen
    const homeScreen = page.locator('.home-screen')
    const isHomeScreen = await homeScreen.isVisible().catch(() => false)

    if (isHomeScreen) {
      // Status bar should NOT be visible on home screen
      const statusBar = page.locator('.bottom-status-bar')
      await expect(statusBar).not.toBeVisible()
    } else {
      // If we have instances, skip this test
      test.skip()
    }
  })

  test('should show Era Code branding on home screen', async ({ page }) => {
    const homeScreen = page.locator('.home-screen')
    const isHomeScreen = await homeScreen.isVisible().catch(() => false)

    if (isHomeScreen) {
      // Check for branding elements
      const branding = page.locator('.home-branding, .home-logo, h1, h2').first()
      await expect(branding).toBeVisible()
    } else {
      test.skip()
    }
  })
})

test.describe('EC-006: Status Bar - With Instances', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for project tab bar (only if we have instances)
    try {
      await page.waitForSelector('.project-tab-bar', { timeout: 5000 })
    } catch {
      test.skip()
    }
  })

  test('should display bottom status bar when instance is active', async ({ page }) => {
    const statusBar = page.locator('.bottom-status-bar')
    await expect(statusBar).toBeVisible()
  })

  test('should show project name in status bar', async ({ page }) => {
    const projectItem = page.locator('.bottom-status-project')
    await expect(projectItem).toBeVisible()

    const text = projectItem.locator('.bottom-status-text')
    await expect(text).toBeVisible()
  })

  test('should show context progress bar', async ({ page }) => {
    const contextItem = page.locator('.bottom-status-context')
    await expect(contextItem).toBeVisible()

    const track = contextItem.locator('.bottom-status-context-track')
    await expect(track).toBeVisible()
  })

  test('should show model selector button', async ({ page }) => {
    const modelItem = page.locator('.bottom-status-model')
    await expect(modelItem).toBeVisible()
  })

  test('should show cost display', async ({ page }) => {
    const costItem = page.locator('.bottom-status-cost')
    await expect(costItem).toBeVisible()

    const text = costItem.locator('.bottom-status-text')
    await expect(text).toContainText('$')
  })

  test('should have dividers between sections', async ({ page }) => {
    const dividers = page.locator('.bottom-status-divider')
    await expect(dividers).toHaveCount(3)
  })

  test('should open model selector modal when clicking model', async ({ page }) => {
    const modelItem = page.locator('.bottom-status-model')
    await modelItem.click()

    const modal = page.locator('.model-selector-modal')
    await expect(modal).toBeVisible({ timeout: 5000 })

    const title = modal.locator('.model-selector-title')
    await expect(title).toContainText('Select Model')
  })

  test('should have search bar in model selector', async ({ page }) => {
    await page.locator('.bottom-status-model').click()
    await page.waitForSelector('.model-selector-modal', { timeout: 5000 })

    const searchInput = page.locator('.model-selector-search-input')
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toHaveAttribute('placeholder', 'Search models...')
  })

  test('should close model selector when clicking cancel', async ({ page }) => {
    await page.locator('.bottom-status-model').click()
    await page.waitForSelector('.model-selector-modal', { timeout: 5000 })

    const cancelButton = page.locator('.model-selector-button-secondary')
    await cancelButton.click()

    const modal = page.locator('.model-selector-modal')
    await expect(modal).not.toBeVisible()
  })

  test('should close model selector when clicking X', async ({ page }) => {
    await page.locator('.bottom-status-model').click()
    await page.waitForSelector('.model-selector-modal', { timeout: 5000 })

    const closeButton = page.locator('.model-selector-close')
    await closeButton.click()

    const modal = page.locator('.model-selector-modal')
    await expect(modal).not.toBeVisible()
  })

  test('should have provider and model dropdowns in selector', async ({ page }) => {
    await page.locator('.bottom-status-model').click()
    await page.waitForSelector('.model-selector-modal', { timeout: 5000 })

    const providerLabel = page.locator('.model-selector-label').filter({ hasText: 'Provider' })
    await expect(providerLabel).toBeVisible()

    const modelLabel = page.locator('.model-selector-label').filter({ hasText: 'Model' })
    await expect(modelLabel).toBeVisible()

    const triggers = page.locator('.model-selector-trigger')
    await expect(triggers).toHaveCount(2)
  })

  test('should have confirm and cancel buttons in selector', async ({ page }) => {
    await page.locator('.bottom-status-model').click()
    await page.waitForSelector('.model-selector-modal', { timeout: 5000 })

    const cancelButton = page.locator('.model-selector-button-secondary')
    await expect(cancelButton).toBeVisible()
    await expect(cancelButton).toContainText('Cancel')

    const selectButton = page.locator('.model-selector-button-primary')
    await expect(selectButton).toBeVisible()
    await expect(selectButton).toContainText('Select')
  })
})

test.describe('EC-006: CSS and Component Structure', () => {
  test('bottom-status-bar.css is loaded', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.home-screen, .project-tab-bar', { timeout: 15000 })

    // Check that our CSS variables/classes are defined
    const styles = await page.evaluate(() => {
      const testEl = document.createElement('div')
      testEl.className = 'bottom-status-bar'
      document.body.appendChild(testEl)
      const computed = window.getComputedStyle(testEl)
      const display = computed.display
      document.body.removeChild(testEl)
      return { display }
    })

    // The CSS should make it flex
    expect(styles.display).toBe('flex')
  })

  test('model-selector.css is loaded', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.home-screen, .project-tab-bar', { timeout: 15000 })

    const styles = await page.evaluate(() => {
      const testEl = document.createElement('div')
      testEl.className = 'model-selector-modal'
      document.body.appendChild(testEl)
      const computed = window.getComputedStyle(testEl)
      const display = computed.display
      document.body.removeChild(testEl)
      return { display }
    })

    // The CSS should make it flex column
    expect(styles.display).toBe('flex')
  })
})
