import { test, expect } from "@playwright/test"

/**
 * UI Comparison Test
 *
 * Captures the full flow of sending a message and receiving a response
 * for comparison with Claude Code's CLI layout
 */

test.describe("UI Layout Comparison", () => {
  test.setTimeout(180000) // 3 minutes for full flow

  test("capture message flow for comparison", async ({ page }) => {
    // Connect to the running instance
    await page.goto("http://localhost:3000")
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    // Screenshot 1: Initial home screen
    await page.screenshot({
      path: "test-screenshots/ui-compare-01-home.png",
      fullPage: true,
    })

    // Click on a recent project to open it
    const recentProject = page.locator('text=~/era-code').first()
    if (await recentProject.isVisible().catch(() => false)) {
      console.log("Clicking on era-code project...")
      await recentProject.click()
      await page.waitForTimeout(3000)
    }

    // Screenshot 2: After opening project - New session view
    await page.screenshot({
      path: "test-screenshots/ui-compare-02-new-session.png",
      fullPage: true,
    })

    // Find the input area - looking for "Ask anything" placeholder
    const inputElement = page.locator('textarea, [contenteditable="true"]').first()

    if (await inputElement.isVisible().catch(() => false)) {
      console.log("Found input element, clicking...")
      await inputElement.click()
      await page.waitForTimeout(500)

      // Screenshot 3: Input focused
      await page.screenshot({
        path: "test-screenshots/ui-compare-03-input-focused.png",
        fullPage: true,
      })

      // Type a message that will trigger tool calls
      const testMessage = "What files are in this project's root directory? List them."
      await inputElement.fill(testMessage)

      // Screenshot 4: Message typed
      await page.screenshot({
        path: "test-screenshots/ui-compare-04-message-typed.png",
        fullPage: true,
      })

      // Send the message - look for the send button (arrow icon)
      const sendButton = page.locator('button[type="submit"], button:has(svg)').last()
      console.log("Looking for send button...")

      // Try clicking the send button or use keyboard
      if (await sendButton.isVisible().catch(() => false)) {
        await sendButton.click()
        console.log("Clicked send button")
      } else {
        // Try Cmd+Enter
        await page.keyboard.press("Meta+Enter")
        console.log("Used Cmd+Enter to send")
      }

      // Wait for response to start
      await page.waitForTimeout(2000)

      // Screenshot 5: Processing started
      await page.screenshot({
        path: "test-screenshots/ui-compare-05-processing.png",
        fullPage: true,
      })

      // Wait and capture more screenshots during processing
      await page.waitForTimeout(3000)
      await page.screenshot({
        path: "test-screenshots/ui-compare-06-processing-2.png",
        fullPage: true,
      })

      // Wait for tool calls to appear
      await page.waitForTimeout(5000)
      await page.screenshot({
        path: "test-screenshots/ui-compare-07-tool-calls.png",
        fullPage: true,
      })

      // Wait for completion (up to 60 seconds)
      const startTime = Date.now()
      const maxWait = 60000
      let screenshotCount = 8

      while (Date.now() - startTime < maxWait) {
        // Take periodic screenshots
        await page.waitForTimeout(5000)
        await page.screenshot({
          path: `test-screenshots/ui-compare-${String(screenshotCount).padStart(2, '0')}-progress.png`,
          fullPage: true,
        })
        screenshotCount++

        // Check if response seems complete (no thinking indicator)
        const thinking = await page.locator('.thinking-card, .thinking-indicator, [class*="thinking"]').isVisible().catch(() => false)
        const working = await page.locator('[class*="working"], [data-status="working"]').isVisible().catch(() => false)

        if (!thinking && !working) {
          console.log("Response appears complete")
          break
        }
      }

      // Final screenshot after completion
      await page.screenshot({
        path: "test-screenshots/ui-compare-final-complete.png",
        fullPage: true,
      })

      // Try to find and expand tool calls summary
      const toolsToggle = page.locator(".grouped-tools-toggle, [class*='tool-toggle']").first()
      if (await toolsToggle.isVisible().catch(() => false)) {
        console.log("Expanding tools summary...")
        await toolsToggle.click()
        await page.waitForTimeout(500)

        await page.screenshot({
          path: "test-screenshots/ui-compare-tools-expanded.png",
          fullPage: true,
        })
      }

      // Capture specific UI components

      // Message stream area
      const messageArea = page.locator('.message-stream, .message-section, [class*="message"]').first()
      if (await messageArea.isVisible().catch(() => false)) {
        await messageArea.screenshot({
          path: "test-screenshots/ui-element-message-area.png",
        })
      }

      // Bottom input area
      const inputArea = page.locator('.prompt-input, [class*="input-container"]').first()
      if (await inputArea.isVisible().catch(() => false)) {
        await inputArea.screenshot({
          path: "test-screenshots/ui-element-input-area.png",
        })
      }

    } else {
      console.log("Could not find input element")
      // Debug: list what's on the page
      const html = await page.evaluate(() => {
        const inputs = document.querySelectorAll('textarea, input, [contenteditable]')
        return Array.from(inputs).map(el => ({
          tag: el.tagName,
          type: el.getAttribute('type'),
          placeholder: el.getAttribute('placeholder'),
          class: el.className
        }))
      })
      console.log("Found inputs:", JSON.stringify(html, null, 2))
    }

    // Take final full page screenshot
    await page.screenshot({
      path: "test-screenshots/ui-compare-final.png",
      fullPage: true,
    })
  })
})
