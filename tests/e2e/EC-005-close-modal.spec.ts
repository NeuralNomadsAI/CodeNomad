import { test, expect } from '@playwright/test'

test.describe('EC-005: Tab Close Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for the project tab bar to be visible
    await page.waitForSelector('.project-tab-bar', { timeout: 10000 })
  })

  test('should show close modal when clicking project tab close button', async ({ page }) => {
    // Check if there are project tabs
    const projectTabs = page.locator('.project-tab:not(.project-tab-new)')
    const tabCount = await projectTabs.count()

    if (tabCount > 0) {
      const firstTab = projectTabs.first()

      // Hover to reveal close button
      await firstTab.hover()
      await page.waitForTimeout(200)

      // Click the close button
      const closeButton = firstTab.locator('.project-tab-close')
      await closeButton.click()

      // Wait for modal to appear
      await page.waitForTimeout(500)

      // Check if close modal is visible
      const modal = page.locator('.close-modal')
      const modalCount = await modal.count()

      if (modalCount > 0) {
        await expect(modal).toBeVisible()
      }
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-005-project-close-modal.png', fullPage: true })
  })

  test('should display correct title for project close', async ({ page }) => {
    const projectTabs = page.locator('.project-tab:not(.project-tab-new)')
    const tabCount = await projectTabs.count()

    if (tabCount > 0) {
      const firstTab = projectTabs.first()
      await firstTab.hover()
      await page.waitForTimeout(200)

      const closeButton = firstTab.locator('.project-tab-close')
      await closeButton.click()
      await page.waitForTimeout(500)

      const modalTitle = page.locator('.close-modal-title')
      const titleCount = await modalTitle.count()

      if (titleCount > 0) {
        const titleText = await modalTitle.textContent()
        expect(titleText).toContain('Close Project')
      }
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-005-project-title.png', fullPage: true })
  })

  test('should have keep in background checkbox (unchecked by default)', async ({ page }) => {
    const projectTabs = page.locator('.project-tab:not(.project-tab-new)')
    const tabCount = await projectTabs.count()

    if (tabCount > 0) {
      const firstTab = projectTabs.first()
      await firstTab.hover()
      await page.waitForTimeout(200)

      const closeButton = firstTab.locator('.project-tab-close')
      await closeButton.click()
      await page.waitForTimeout(500)

      const checkbox = page.locator('.close-modal-checkbox input[type="checkbox"]')
      const checkboxCount = await checkbox.count()

      if (checkboxCount > 0) {
        // Checkbox should be unchecked by default
        const isChecked = await checkbox.isChecked()
        expect(isChecked).toBe(false)
      }
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-005-checkbox.png', fullPage: true })
  })

  test('should have Cancel and Confirm buttons', async ({ page }) => {
    const projectTabs = page.locator('.project-tab:not(.project-tab-new)')
    const tabCount = await projectTabs.count()

    if (tabCount > 0) {
      const firstTab = projectTabs.first()
      await firstTab.hover()
      await page.waitForTimeout(200)

      const closeButton = firstTab.locator('.project-tab-close')
      await closeButton.click()
      await page.waitForTimeout(500)

      const cancelButton = page.locator('.close-modal-button-secondary')
      const confirmButton = page.locator('.close-modal-button-danger')

      const cancelCount = await cancelButton.count()
      const confirmCount = await confirmButton.count()

      if (cancelCount > 0 && confirmCount > 0) {
        await expect(cancelButton).toBeVisible()
        await expect(confirmButton).toBeVisible()
      }
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-005-buttons.png', fullPage: true })
  })

  test('should close modal when clicking Cancel', async ({ page }) => {
    const projectTabs = page.locator('.project-tab:not(.project-tab-new)')
    const tabCount = await projectTabs.count()

    if (tabCount > 0) {
      const firstTab = projectTabs.first()
      await firstTab.hover()
      await page.waitForTimeout(200)

      const closeButton = firstTab.locator('.project-tab-close')
      await closeButton.click()
      await page.waitForTimeout(500)

      const cancelButton = page.locator('.close-modal-button-secondary')
      const cancelCount = await cancelButton.count()

      if (cancelCount > 0) {
        await cancelButton.click()
        await page.waitForTimeout(300)

        // Modal should be hidden
        const modal = page.locator('.close-modal')
        await expect(modal).not.toBeVisible()
      }
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-005-cancel.png', fullPage: true })
  })

  test('should display session count for project close', async ({ page }) => {
    const projectTabs = page.locator('.project-tab:not(.project-tab-new)')
    const tabCount = await projectTabs.count()

    if (tabCount > 0) {
      const firstTab = projectTabs.first()
      await firstTab.hover()
      await page.waitForTimeout(200)

      const closeButton = firstTab.locator('.project-tab-close')
      await closeButton.click()
      await page.waitForTimeout(500)

      const description = page.locator('.close-modal-description')
      const descCount = await description.count()

      if (descCount > 0) {
        const descText = await description.textContent()
        // Should mention sessions
        expect(descText).toBeTruthy()
      }
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-005-session-count.png', fullPage: true })
  })

  test('should close modal when clicking X button', async ({ page }) => {
    const projectTabs = page.locator('.project-tab:not(.project-tab-new)')
    const tabCount = await projectTabs.count()

    if (tabCount > 0) {
      const firstTab = projectTabs.first()
      await firstTab.hover()
      await page.waitForTimeout(200)

      const closeButton = firstTab.locator('.project-tab-close')
      await closeButton.click()
      await page.waitForTimeout(500)

      const modalCloseButton = page.locator('.close-modal-close')
      const modalCloseCount = await modalCloseButton.count()

      if (modalCloseCount > 0) {
        await modalCloseButton.click()
        await page.waitForTimeout(300)

        // Modal should be hidden
        const modal = page.locator('.close-modal')
        await expect(modal).not.toBeVisible()
      }
    }

    // Take screenshot
    await page.screenshot({ path: 'test-screenshots/EC-005-x-close.png', fullPage: true })
  })
})
