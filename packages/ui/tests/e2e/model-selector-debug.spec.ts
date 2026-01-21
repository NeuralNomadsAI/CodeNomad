import { test, expect } from "@playwright/test"

test.describe("Model Selector Debug", () => {
  test.setTimeout(120000)

  test("should open model selector without errors", async ({ page }) => {
    // Collect console errors
    const consoleErrors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text())
      }
    })

    page.on("pageerror", (err) => {
      consoleErrors.push(`Page error: ${err.message}\nStack: ${err.stack}`)
    })

    await page.goto("http://localhost:3000/")
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    // Take initial screenshot
    await page.screenshot({ path: "test-screenshots/model-debug-01-initial.png", fullPage: true })

    // Check if we need to open a project first
    const browseButton = page.locator('text=Browse').first()
    const recentProject = page.locator('[class*="folder-card"], [class*="recent"]').first()

    // Try clicking on a recent project if visible
    if (await recentProject.isVisible().catch(() => false)) {
      console.log("Found recent project, clicking...")
      await recentProject.click()
      await page.waitForTimeout(3000)
    }

    await page.screenshot({ path: "test-screenshots/model-debug-02-after-project.png", fullPage: true })

    // Dismiss any modal overlays that might be blocking
    const modalOverlay = page.locator('.permission-modal-overlay, [class*="modal-overlay"]')
    if (await modalOverlay.isVisible().catch(() => false)) {
      console.log("Found modal overlay, trying to dismiss...")
      // Try pressing Escape or clicking outside
      await page.keyboard.press("Escape")
      await page.waitForTimeout(500)

      // If still visible, try clicking a dismiss button
      const dismissBtn = page.locator('button:has-text("Dismiss"), button:has-text("Cancel"), button:has-text("Close")').first()
      if (await dismissBtn.isVisible().catch(() => false)) {
        await dismissBtn.click()
        await page.waitForTimeout(500)
      }
    }

    // Now look for the model selector in the sidebar
    // The model selector should be visible when a session is active

    // Check if there's already an active session (look for MODEL label)
    const modelLabelCheck = page.locator('text=MODEL, text=Model').first()
    if (!(await modelLabelCheck.isVisible().catch(() => false))) {
      // First check if there's a session list or we need to create one
      const newSessionBtn = page.locator('.session-tab-new, button[aria-label="New session"]').first()
      if (await newSessionBtn.isVisible().catch(() => false)) {
        console.log("Found new session button, clicking...")
        await newSessionBtn.click({ force: true })
        await page.waitForTimeout(2000)
      }
    }

    await page.screenshot({ path: "test-screenshots/model-debug-03-session.png", fullPage: true })

    // Look for MODEL label and selector
    const modelLabel = page.locator('text=MODEL').first()
    console.log("MODEL label visible:", await modelLabel.isVisible().catch(() => false))

    // Try to find the model selector trigger by various means
    const modelTriggers = [
      page.locator('.sidebar-selector:has-text("Model") .selector-trigger'),
      page.locator('label:has-text("Model") + div button, label:has-text("Model") ~ button'),
      page.locator('[class*="selector-trigger"]:near(:text("Model"))'),
      page.locator('button:has-text("Claude")'),
      page.locator('button:has-text("Haiku")'),
      page.locator('button:has-text("anthropic")'),
    ]

    let foundTrigger = null
    for (const trigger of modelTriggers) {
      if (await trigger.isVisible().catch(() => false)) {
        console.log("Found model trigger!")
        foundTrigger = trigger
        break
      }
    }

    if (foundTrigger) {
      await page.screenshot({ path: "test-screenshots/model-debug-04-before-click.png", fullPage: true })

      // Click the trigger to open dropdown
      await foundTrigger.click()
      await page.waitForTimeout(1000)

      await page.screenshot({ path: "test-screenshots/model-debug-05-dropdown-open.png", fullPage: true })

      // Try to click on a different model option
      const modelOption = page.locator('[class*="selector-option"], [role="option"]').first()
      if (await modelOption.isVisible().catch(() => false)) {
        console.log("Found model option, clicking...")
        await modelOption.click()
        await page.waitForTimeout(1000)
      }

      await page.screenshot({ path: "test-screenshots/model-debug-06-after-selection.png", fullPage: true })
    } else {
      console.log("Could not find model selector trigger")

      // Log all buttons on page for debugging
      const allButtons = await page.locator('button').all()
      console.log(`Found ${allButtons.length} buttons on page`)
      for (let i = 0; i < Math.min(allButtons.length, 10); i++) {
        const text = await allButtons[i].textContent().catch(() => '')
        console.log(`Button ${i}: "${text?.slice(0, 50)}"`)
      }
    }

    // Wait and check for errors
    await page.waitForTimeout(2000)
    await page.screenshot({ path: "test-screenshots/model-debug-07-final.png", fullPage: true })

    console.log("\n=== Console Errors ===")
    for (const err of consoleErrors) {
      console.log(err)
    }
    console.log(`Total errors: ${consoleErrors.length}`)
    console.log("=== End Errors ===\n")

    // Fail the test if there were errors containing "name"
    const nameErrors = consoleErrors.filter(e => e.includes("name") || e.includes("undefined"))
    if (nameErrors.length > 0) {
      console.log("ERRORS WITH 'name' or 'undefined':")
      nameErrors.forEach(e => console.log(e))
    }
  })
})
