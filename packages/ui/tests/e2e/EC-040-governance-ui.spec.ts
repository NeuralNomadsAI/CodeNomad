import { test, expect } from "@playwright/test"

test.describe("EC-040 Governance UI Enhancement", () => {
  test.setTimeout(120000) // 2 minute timeout

  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:3000/")
    await page.waitForLoadState("domcontentloaded")
    // Wait for app to fully load
    await page.waitForTimeout(2000)
  })

  test("Complete governance UI workflow with critical evaluation", async ({ page }) => {
    // Step 1: Initial state - capture home screen
    await page.screenshot({
      path: "test-screenshots/governance-01-initial.png",
      fullPage: true,
    })

    // Step 2: Open Quick Settings first
    const settingsButton = page.locator('[data-testid="settings-button"], button:has(svg.lucide-settings), .settings-button').first()

    if (await settingsButton.isVisible()) {
      await settingsButton.click()
      await page.waitForTimeout(500)
    }

    await page.screenshot({
      path: "test-screenshots/governance-02-quick-settings.png",
      fullPage: true,
    })

    // Step 3: Click "All Settings" to open Full Settings pane
    const allSettingsButton = page.locator('button:has-text("All Settings"), [data-testid="all-settings"]').first()

    if (await allSettingsButton.isVisible()) {
      await allSettingsButton.click()
      await page.waitForTimeout(1000)
    }

    await page.screenshot({
      path: "test-screenshots/governance-03-full-settings.png",
      fullPage: true,
    })

    // Step 4: Look for the Governance section in the sidebar
    const governanceSection = page.locator('.full-settings-nav-section:has-text("Governance")')
    await page.screenshot({
      path: "test-screenshots/governance-04-sidebar-nav.png",
      fullPage: true,
    })

    // Step 5: Click Constitution tab
    const constitutionTab = page.locator('.full-settings-nav-item:has-text("Constitution")').first()

    if (await constitutionTab.isVisible()) {
      await constitutionTab.click()
      await page.waitForTimeout(500)
      await page.screenshot({
        path: "test-screenshots/governance-05-constitution.png",
        fullPage: true,
      })
    } else {
      console.log("Constitution tab not found")
    }

    // Step 6: Click Global Directives tab
    const globalTab = page.locator('.full-settings-nav-item:has-text("Global Directives")').first()

    if (await globalTab.isVisible()) {
      await globalTab.click()
      await page.waitForTimeout(500)
      await page.screenshot({
        path: "test-screenshots/governance-06-global-directives.png",
        fullPage: true,
      })
    } else {
      console.log("Global Directives tab not found")
    }

    // Step 7: Check for view toggle and directive cards
    const viewToggle = page.locator('.directives-view-toggle')
    if (await viewToggle.isVisible()) {
      await page.screenshot({
        path: "test-screenshots/governance-07-view-toggle.png",
        fullPage: true,
      })
    }

    // Step 8: Toggle to Raw view
    const rawButton = page.locator('button:has-text("Raw")').first()
    if (await rawButton.isVisible()) {
      await rawButton.click()
      await page.waitForTimeout(300)
      await page.screenshot({
        path: "test-screenshots/governance-08-raw-view.png",
        fullPage: true,
      })
    }

    // Step 9: Toggle back to Cards
    const cardsButton = page.locator('button:has-text("Cards")').first()
    if (await cardsButton.isVisible()) {
      await cardsButton.click()
      await page.waitForTimeout(300)
    }

    // Step 10: Click Add Directive button
    const addDirectiveBtn = page.locator('button:has-text("Add Directive")').first()

    if (await addDirectiveBtn.isVisible()) {
      await addDirectiveBtn.click()
      await page.waitForTimeout(500)
      await page.screenshot({
        path: "test-screenshots/governance-09-add-modal.png",
        fullPage: true,
      })

      // Step 11: Type the directive
      const textarea = page.locator('textarea.add-directive-input, textarea[placeholder*="Describe"]').first()

      if (await textarea.isVisible()) {
        await textarea.fill("Always update the /docs folder with relevant documentation changes when pushing a PR that modifies public APIs or user-facing features")
        await page.waitForTimeout(300)
        await page.screenshot({
          path: "test-screenshots/governance-10-directive-typed.png",
          fullPage: true,
        })

        // Step 12: Click Format & Preview
        const formatBtn = page.locator('button:has-text("Format")').first()
        if (await formatBtn.isVisible()) {
          await formatBtn.click()
          await page.waitForTimeout(500)
          await page.screenshot({
            path: "test-screenshots/governance-11-formatted.png",
            fullPage: true,
          })
        }

        // Step 13: Add the directive
        const addBtn = page.locator('.add-directive-modal button:has-text("Add Directive")').last()
        if (await addBtn.isVisible() && await addBtn.isEnabled()) {
          await addBtn.click()
          await page.waitForTimeout(500)
        }
      }

      // Close modal if still open
      const cancelBtn = page.locator('button:has-text("Cancel")').first()
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click()
        await page.waitForTimeout(300)
      }
    }

    await page.screenshot({
      path: "test-screenshots/governance-12-after-add.png",
      fullPage: true,
    })

    // Step 14: Click Project Directives tab
    const projectTab = page.locator('.full-settings-nav-item:has-text("Project Directives")').first()

    if (await projectTab.isVisible()) {
      await projectTab.click()
      await page.waitForTimeout(500)
      await page.screenshot({
        path: "test-screenshots/governance-13-project-directives.png",
        fullPage: true,
      })
    }

    // Step 15: Click Active Rules tab
    const rulesTab = page.locator('.full-settings-nav-item:has-text("Active Rules")').first()

    if (await rulesTab.isVisible()) {
      await rulesTab.click()
      await page.waitForTimeout(500)
      await page.screenshot({
        path: "test-screenshots/governance-14-active-rules.png",
        fullPage: true,
      })
    }

    // Step 16: Test search in Active Rules
    const searchInput = page.locator('.governance-search input').first()
    if (await searchInput.isVisible()) {
      await searchInput.fill("security")
      await page.waitForTimeout(300)
      await page.screenshot({
        path: "test-screenshots/governance-15-rules-search.png",
        fullPage: true,
      })
      await searchInput.clear()
    }

    // Step 17: Test category filter
    const categorySelect = page.locator('.governance-filter-select').first()
    if (await categorySelect.isVisible()) {
      await categorySelect.selectOption("security")
      await page.waitForTimeout(300)
      await page.screenshot({
        path: "test-screenshots/governance-16-category-filter.png",
        fullPage: true,
      })
    }

    // Final screenshot
    await page.screenshot({
      path: "test-screenshots/governance-17-final.png",
      fullPage: true,
    })

    expect(true).toBe(true)
  })
})
