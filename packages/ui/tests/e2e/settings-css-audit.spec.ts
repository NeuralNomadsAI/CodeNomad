import { test, expect } from "@playwright/test"

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "session", label: "Session" },
  { id: "models", label: "Models" },
  { id: "mcp", label: "MCP Servers" },
  { id: "commands", label: "Slash Commands" },
  { id: "governance-constitution", label: "Constitution" },
  { id: "governance-global", label: "Global Directives" },
  { id: "governance-project", label: "Project Directives" },
  { id: "governance-rules", label: "Active Rules" },
  { id: "sessions", label: "All Sessions" },
  { id: "environment", label: "Environment" },
  { id: "accounts", label: "Accounts" },
  { id: "era-code", label: "Era Code" },
  { id: "about", label: "About" },
]

test.describe("Settings CSS Audit", () => {
  test.setTimeout(60000)

  test.beforeEach(async ({ page }) => {
    // Use the actual running server
    await page.goto("http://localhost:3000")
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000) // Give app time to initialize
  })

  test("audit all settings sections for CSS issues", async ({ page }) => {
    // Wait for app to load
    await page.waitForSelector("body", { timeout: 10000 })

    // Take screenshot of initial state
    await page.screenshot({ path: "test-screenshots/settings-audit/00-initial.png", fullPage: true })

    // Look for settings button or gear icon
    const settingsBtn = page.locator('[data-testid="settings-button"], button:has(svg), .settings-btn').first()

    // Try to find and click a settings trigger
    const possibleTriggers = [
      'button:has-text("Settings")',
      '[aria-label="Settings"]',
      'button:has(svg.lucide-settings)',
      '.quick-settings-trigger',
    ]

    let foundTrigger = false
    for (const selector of possibleTriggers) {
      const el = page.locator(selector).first()
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click()
        foundTrigger = true
        break
      }
    }

    if (!foundTrigger) {
      // Try clicking anywhere that might open settings
      await page.screenshot({ path: "test-screenshots/settings-audit/00-no-settings-found.png", fullPage: true })
      console.log("Could not find settings trigger")
    }

    await page.waitForTimeout(500)
    await page.screenshot({ path: "test-screenshots/settings-audit/01-after-settings-click.png", fullPage: true })

    // Look for "All Settings" or similar link to open full settings
    const allSettingsLink = page.locator('button:has-text("All Settings"), a:has-text("All Settings"), [data-testid="all-settings"]').first()
    if (await allSettingsLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await allSettingsLink.click()
      await page.waitForTimeout(500)
    }

    await page.screenshot({ path: "test-screenshots/settings-audit/02-full-settings.png", fullPage: true })

    // Now iterate through each section (nav items are now Tailwind-styled, not legacy CSS classes)
    for (const section of SECTIONS) {
      // After migration, nav items use inline Tailwind classes instead of .full-settings-nav-item
      const navItem = page.locator(`[class*="cursor-pointer"]:has-text("${section.label}"), button:has-text("${section.label}")`).first()

      if (await navItem.isVisible({ timeout: 1000 }).catch(() => false)) {
        await navItem.click()
        await page.waitForTimeout(300)

        // Take screenshot
        await page.screenshot({
          path: `test-screenshots/settings-audit/section-${section.id}.png`,
          fullPage: true
        })

        // Check for CSS issues — content area uses inline Tailwind (flex-1 overflow-y-auto)
        const content = page.locator('[class*="flex-1"][class*="overflow-y-auto"]').first()
        const contentBox = await content.boundingBox().catch(() => null)

        // Log any potential issues
        if (!contentBox || contentBox.width < 100) {
          console.log(`WARNING: Section "${section.label}" may have CSS issues - content area too small or missing`)
        }

        // Check for unstyled elements (elements with no computed styles)
        const unstyledCheck = await page.evaluate(() => {
          // Find the scrollable content area
          const contentArea = document.querySelector('[class*="flex-1"][class*="overflow-y-auto"]')
          if (!contentArea) return { hasContent: false, issues: ["No content area found"] }

          const issues: string[] = []
          const children = contentArea.querySelectorAll("*")

          // Check for elements that might be unstyled
          children.forEach((el) => {
            const styles = window.getComputedStyle(el)

            // Check for text that's invisible
            if (styles.color === "rgba(0, 0, 0, 0)" || styles.opacity === "0") {
              issues.push(`Invisible element: ${el.tagName.toLowerCase()}`)
            }
          })

          return { hasContent: children.length > 0, issues }
        })

        if (unstyledCheck.issues.length > 0) {
          console.log(`Section "${section.label}" issues:`, unstyledCheck.issues)
        }
      } else {
        console.log(`Nav item for "${section.label}" not found`)
      }
    }

    // Final summary screenshot
    await page.screenshot({ path: "test-screenshots/settings-audit/99-final.png", fullPage: true })
  })
})
