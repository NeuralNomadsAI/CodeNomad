import { test, expect } from "@playwright/test"

test.describe("EC-041: Models Page Redesign", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:3000")
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)
  })

  test("should display the redesigned Models page with pricing", async ({ page }) => {
    await page.screenshot({ path: "test-screenshots/EC-041-01-initial.png", fullPage: true })

    // Click settings button (gear in bottom status bar)
    const settingsButton = page.locator(".bottom-status-settings, [title='Settings']")
    if (await settingsButton.count() > 0) {
      await settingsButton.first().click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: "test-screenshots/EC-041-02-settings-open.png", fullPage: true })
    }

    // Click "All Settings" to open full settings pane
    const allSettingsButton = page.locator("text=All Settings")
    if (await allSettingsButton.isVisible()) {
      await allSettingsButton.click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: "test-screenshots/EC-041-02b-full-settings.png", fullPage: true })
    }

    // Click on Models in the navigation sidebar
    const modelsNav = page.locator(".full-settings-nav-item:has-text('Models'), button:has-text('Models')")
    if (await modelsNav.count() > 0) {
      await modelsNav.first().click()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: "test-screenshots/EC-041-03-models-section.png", fullPage: true })
    }

    const quickAccessCards = page.locator(".models-quick-access-card")
    const cardCount = await quickAccessCards.count()
    console.log("Quick Access cards: " + cardCount)

    const pricingElements = page.locator(".models-quick-access-price, .model-catalog-col-price")
    const pricingCount = await pricingElements.count()
    console.log("Pricing elements: " + pricingCount)

    const modelCatalog = page.locator(".model-catalog")
    if (await modelCatalog.isVisible()) {
      await page.screenshot({ path: "test-screenshots/EC-041-04-model-catalog.png", fullPage: true })
    }

    const filterToggle = page.locator(".model-catalog-filter-toggle")
    if (await filterToggle.isVisible()) {
      await filterToggle.click()
      await page.waitForTimeout(300)
      await page.screenshot({ path: "test-screenshots/EC-041-05-filter-active.png", fullPage: true })
    }

    await page.screenshot({ path: "test-screenshots/EC-041-06-final.png", fullPage: true })
  })

  test("should show provider list in catalog sidebar", async ({ page }) => {
    // Open settings
    const settingsButton = page.locator(".bottom-status-settings, [title='Settings']")
    if (await settingsButton.count() > 0) {
      await settingsButton.first().click()
      await page.waitForTimeout(500)
    }

    // Open full settings
    const allSettingsButton = page.locator("text=All Settings")
    if (await allSettingsButton.isVisible()) {
      await allSettingsButton.click()
      await page.waitForTimeout(500)
    }

    // Click Models in nav
    const modelsNav = page.locator(".full-settings-nav-item:has-text('Models'), button:has-text('Models')")
    if (await modelsNav.count() > 0) {
      await modelsNav.first().click()
      await page.waitForTimeout(1000)
    }

    const providerItems = page.locator(".model-catalog-provider-item")
    const count = await providerItems.count()
    console.log("Provider items: " + count)

    if (count > 0) {
      await providerItems.first().click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: "test-screenshots/EC-041-07-provider-selected.png", fullPage: true })
    }

    // Click on Anthropic (a connected provider) to see "Connected" pill
    const anthropicItem = page.locator(".model-catalog-provider-item:has-text('Anthropic')")
    if (await anthropicItem.count() > 0) {
      await anthropicItem.first().click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: "test-screenshots/EC-041-09-connected-provider.png", fullPage: true })
    }

    // Test clicking Configure button opens modal
    const configureButton = page.locator(".model-catalog-configure-badge, .model-catalog-connected-badge.clickable")
    if (await configureButton.count() > 0) {
      await configureButton.first().click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: "test-screenshots/EC-041-10-config-modal.png", fullPage: true })

      // Close modal
      const closeButton = page.locator(".modal-button--secondary:has-text('Cancel')")
      if (await closeButton.count() > 0) {
        await closeButton.click()
        await page.waitForTimeout(300)
      }
    }

    const modelRows = page.locator(".model-catalog-model-row")
    const modelCount = await modelRows.count()
    console.log("Model rows: " + modelCount)

    if (modelCount > 0) {
      await modelRows.first().hover()
      await page.waitForTimeout(200)
      await page.screenshot({ path: "test-screenshots/EC-041-08-model-hover.png", fullPage: true })
    }
  })
})
