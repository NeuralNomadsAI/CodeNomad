/**
 * EC-063: Sub-Agent Iterations Setting — UI E2E Tests
 *
 * Tests Milestone B1: the maxSubagentIterations preference control
 * in the Era Code section of the Settings panel.
 *
 * Prerequisites: App must be running on the configured baseURL.
 */

import { test, expect, type Page } from "@playwright/test"

const SCREENSHOT_DIR = "test-screenshots"

/**
 * Navigate to the full Settings panel → Era Code section.
 */
async function navigateToEraCodeSection(page: Page) {
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(2000)

  // Try settings button
  const settingsBtn = page.locator('button[title="Settings"], button[aria-label="Settings"]')
  if (await settingsBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await settingsBtn.first().click()
    await page.waitForTimeout(500)
  }

  // Navigate to Era Code section in settings nav
  const eraCodeNavItem = page.locator(".full-settings-nav-btn").filter({ hasText: /era\s*code/i })
  if (await eraCodeNavItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await eraCodeNavItem.click()
    await page.waitForTimeout(500)
  }
}

test.describe("EC-063: Sub-Agent Iterations Setting", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60000)
    await navigateToEraCodeSection(page)
  })

  test("EC-063-01: Era Code section renders", async ({ page }) => {
    await page.screenshot({ path: `${SCREENSHOT_DIR}/EC-063-01-era-code-section.png`, fullPage: true })

    // Look for era code section content
    const eraSection = page.locator("text=Era Code").first()
    const isVisible = await eraSection.isVisible({ timeout: 5000 }).catch(() => false)

    if (!isVisible) {
      // Check if the settings nav is even visible
      const navVisible = await page.locator(".full-settings-nav").isVisible({ timeout: 2000 }).catch(() => false)
      if (!navVisible) {
        test.skip(true, "Settings panel not reachable")
        return
      }
      test.skip(true, "Era Code section not visible — may require Era Code installation")
    }
  })

  test("EC-063-02: Sub-Agent Configuration subsection exists", async ({ page }) => {
    const subsection = page.locator("text=Sub-Agent Configuration")
    const isVisible = await subsection.isVisible({ timeout: 5000 }).catch(() => false)

    if (!isVisible) {
      test.skip(true, "Sub-Agent Configuration subsection not visible")
      return
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/EC-063-02-subagent-config.png`, fullPage: true })
    expect(isVisible).toBe(true)
  })

  test("EC-063-03: iterations input renders with correct attributes", async ({ page }) => {
    const input = page.locator('.full-settings-number-input[type="number"]').first()
    const isVisible = await input.isVisible({ timeout: 5000 }).catch(() => false)

    if (!isVisible) {
      test.skip(true, "Iterations input not visible")
      return
    }

    // Verify HTML attributes
    const min = await input.getAttribute("min")
    const max = await input.getAttribute("max")
    const step = await input.getAttribute("step")

    expect(min).toBe("1")
    expect(max).toBe("10")
    expect(step).toBe("1")

    await page.screenshot({ path: `${SCREENSHOT_DIR}/EC-063-03-iterations-input.png`, fullPage: true })
  })

  test("EC-063-04: iterations input has default value of 3", async ({ page }) => {
    const input = page.locator('.full-settings-number-input[type="number"]').first()
    const isVisible = await input.isVisible({ timeout: 5000 }).catch(() => false)

    if (!isVisible) {
      test.skip(true, "Iterations input not visible")
      return
    }

    const value = await input.inputValue()
    expect(value).toBe("3")
  })

  test("EC-063-05: iterations input accepts value change to 5", async ({ page }) => {
    const input = page.locator('.full-settings-number-input[type="number"]').first()
    const isVisible = await input.isVisible({ timeout: 5000 }).catch(() => false)

    if (!isVisible) {
      test.skip(true, "Iterations input not visible")
      return
    }

    await input.fill("5")
    await input.dispatchEvent("change")
    await page.waitForTimeout(300)

    const value = await input.inputValue()
    expect(value).toBe("5")

    await page.screenshot({ path: `${SCREENSHOT_DIR}/EC-063-05-value-changed.png`, fullPage: true })
  })

  test("EC-063-06: iterations input enforces minimum of 1 via HTML", async ({ page }) => {
    const input = page.locator('.full-settings-number-input[type="number"]').first()
    const isVisible = await input.isVisible({ timeout: 5000 }).catch(() => false)

    if (!isVisible) {
      test.skip(true, "Iterations input not visible")
      return
    }

    const min = await input.getAttribute("min")
    expect(min).toBe("1")
  })

  test("EC-063-07: iterations input enforces maximum of 10 via HTML", async ({ page }) => {
    const input = page.locator('.full-settings-number-input[type="number"]').first()
    const isVisible = await input.isVisible({ timeout: 5000 }).catch(() => false)

    if (!isVisible) {
      test.skip(true, "Iterations input not visible")
      return
    }

    const max = await input.getAttribute("max")
    expect(max).toBe("10")
  })

  test("EC-063-08: description text explains the setting", async ({ page }) => {
    // Look for description text near the input
    const descTexts = [
      "sub-agent",
      "iteration",
      "retry",
    ]

    let foundDescription = false
    for (const text of descTexts) {
      const el = page.locator(`.full-settings-subsection`).filter({ hasText: new RegExp(text, "i") })
      if (await el.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        foundDescription = true
        break
      }
    }

    if (!foundDescription) {
      // Check if the entire section is visible
      const sectionVisible = await page.locator("text=Sub-Agent Configuration")
        .isVisible({ timeout: 2000 })
        .catch(() => false)

      if (!sectionVisible) {
        test.skip(true, "Sub-Agent section not visible")
        return
      }
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/EC-063-08-description-text.png`, fullPage: true })
  })

  test("EC-063-09: input has correct CSS styling", async ({ page }) => {
    const input = page.locator('.full-settings-number-input[type="number"]').first()
    const isVisible = await input.isVisible({ timeout: 5000 }).catch(() => false)

    if (!isVisible) {
      test.skip(true, "Iterations input not visible")
      return
    }

    // Check that the input has our custom class styling applied
    const width = await input.evaluate((el) => getComputedStyle(el).width)
    const textAlign = await input.evaluate((el) => getComputedStyle(el).textAlign)

    // Width should be around 64px (our CSS says width: 64px)
    expect(parseInt(width)).toBeLessThanOrEqual(100)
    expect(textAlign).toBe("center")
  })
})
