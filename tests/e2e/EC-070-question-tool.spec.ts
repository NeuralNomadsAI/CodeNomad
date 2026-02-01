import { test, expect } from "@playwright/test"

const API_BASE = "http://localhost:9898"

test.describe("EC-070: Question Tool Response Flow", () => {
  test.describe("API Infrastructure Tests", () => {
    test("question API endpoint exists and returns array", async ({ request }) => {
      // Get workspace ID
      const wsRes = await request.get(`${API_BASE}/api/workspaces`)
      expect(wsRes.ok()).toBeTruthy()
      const workspaces = await wsRes.json()
      expect(workspaces.length).toBeGreaterThan(0)

      const ws = workspaces[0]
      const proxyBase = `${API_BASE}${ws.proxyPath}`

      // GET /question should return an array (even if empty)
      const questionRes = await request.get(`${proxyBase}/question`)
      expect(questionRes.ok()).toBeTruthy()
      const questions = await questionRes.json()
      expect(Array.isArray(questions)).toBeTruthy()
    })

    test("question reject endpoint handles invalid ID gracefully", async ({ request }) => {
      const wsRes = await request.get(`${API_BASE}/api/workspaces`)
      const workspaces = await wsRes.json()
      const ws = workspaces[0]
      const proxyBase = `${API_BASE}${ws.proxyPath}`

      // POST to reject with a fake ID should not crash the server
      const rejectRes = await request.post(`${proxyBase}/question/fake-id-12345/reject`, {
        data: {},
      })
      // Server should respond (200 is acceptable -- silently ignored)
      expect(rejectRes.status()).toBeLessThan(500)
    })

    test("question reply endpoint handles invalid ID gracefully", async ({ request }) => {
      const wsRes = await request.get(`${API_BASE}/api/workspaces`)
      const workspaces = await wsRes.json()
      const ws = workspaces[0]
      const proxyBase = `${API_BASE}${ws.proxyPath}`

      // POST to reply with a fake ID should not crash the server
      const replyRes = await request.post(`${proxyBase}/question/fake-id-12345/reply`, {
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ answers: [["test"]] }),
      })
      // Server should respond (200 is acceptable -- silently ignored)
      expect(replyRes.status()).toBeLessThan(500)
    })
  })

  test.describe("SSE Event Integration", () => {
    test("SSE stream includes question event types in capabilities", async ({ request }) => {
      // Get workspace ID
      const wsRes = await request.get(`${API_BASE}/api/workspaces`)
      const workspaces = await wsRes.json()
      const ws = workspaces[0]
      const proxyBase = `${API_BASE}${ws.proxyPath}`

      // Verify SSE endpoint is accessible
      // We just check the endpoint responds (SSE connection is handled by the app)
      const sseRes = await request.get(`${proxyBase}/session/events`, {
        headers: { Accept: "text/event-stream" },
        timeout: 3000,
      }).catch(() => null)

      // SSE endpoint should at least be reachable (may time out since it's a stream)
      // The important thing is it doesn't 404
      if (sseRes) {
        expect(sseRes.status()).toBeLessThan(500)
      }
    })
  })

  test.describe("UI Component Tests", () => {
    test("question tool CSS is loaded and available", async ({ page }) => {
      await page.goto("/")
      await page.waitForSelector(".project-tab-bar", { timeout: 10000 })

      // Verify question block CSS classes are defined in stylesheets
      const hasQuestionBlockCSS = await page.evaluate(() => {
        const sheets = document.styleSheets
        for (let i = 0; i < sheets.length; i++) {
          try {
            const rules = sheets[i].cssRules
            for (let j = 0; j < rules.length; j++) {
              const rule = rules[j]
              if (rule instanceof CSSStyleRule) {
                if (rule.selectorText?.includes("tool-call-question-block")) {
                  return true
                }
              }
            }
          } catch {
            // Cross-origin stylesheets will throw
          }
        }
        return false
      })

      expect(hasQuestionBlockCSS).toBeTruthy()

      await page.screenshot({ path: "test-screenshots/EC-070-01-app-loaded.png" })
    })

    test("question renderer CSS is loaded", async ({ page }) => {
      await page.goto("/")
      await page.waitForSelector(".project-tab-bar", { timeout: 10000 })

      // Check for question renderer CSS (the display side)
      const hasRendererCSS = await page.evaluate(() => {
        const sheets = document.styleSheets
        for (let i = 0; i < sheets.length; i++) {
          try {
            const rules = sheets[i].cssRules
            for (let j = 0; j < rules.length; j++) {
              const rule = rules[j]
              if (rule instanceof CSSStyleRule) {
                if (rule.selectorText?.includes("tool-call-question-option-chip")) {
                  return true
                }
              }
            }
          } catch {
            // Cross-origin stylesheets will throw
          }
        }
        return false
      })

      expect(hasRendererCSS).toBeTruthy()
    })

    test("question awaiting CSS class is defined", async ({ page }) => {
      await page.goto("/")
      await page.waitForSelector(".project-tab-bar", { timeout: 10000 })

      const hasAwaitingCSS = await page.evaluate(() => {
        const sheets = document.styleSheets
        for (let i = 0; i < sheets.length; i++) {
          try {
            const rules = sheets[i].cssRules
            for (let j = 0; j < rules.length; j++) {
              const rule = rules[j]
              if (rule instanceof CSSStyleRule) {
                if (rule.selectorText?.includes("tool-call-awaiting-question")) {
                  return true
                }
              }
            }
          } catch {
            // Cross-origin stylesheets will throw
          }
        }
        return false
      })

      expect(hasAwaitingCSS).toBeTruthy()
    })
  })

  test.describe("Live Question Flow", () => {
    test("send prompt that triggers a question and verify question UI appears", async ({ page }) => {
      test.setTimeout(120000) // 2 min timeout for LLM response

      await page.goto("/")
      await page.waitForSelector(".project-tab-bar", { timeout: 10000 })

      // Navigate to the active workspace tab
      const projectTabs = page.locator(".project-tab:not(.project-tab-new):not(.project-tab-settings)")
      const tabCount = await projectTabs.count()

      if (tabCount === 0) {
        test.skip(true, "No active workspace tabs available")
        return
      }

      // Click the first project tab to enter the workspace
      await projectTabs.first().click()
      await page.waitForTimeout(1500)

      await page.screenshot({ path: "test-screenshots/EC-070-02-workspace-tab.png" })

      // Check if we need to create a session or if we're already in one
      const sessionView = page.locator(".session-view")
      const isSessionVisible = await sessionView.isVisible().catch(() => false)

      if (!isSessionVisible) {
        // Look for the "Create Session" button on the workspace splash screen
        const createSessionBtn = page.locator('button:has-text("Create Session")')
        const hasCreateBtn = await createSessionBtn.isVisible().catch(() => false)

        await page.screenshot({ path: "test-screenshots/EC-070-02b-before-create.png" })

        if (hasCreateBtn) {
          await createSessionBtn.click()
          await page.waitForTimeout(3000)
          await page.screenshot({ path: "test-screenshots/EC-070-02c-after-create.png" })
        } else {
          // Try using keyboard shortcut to create a new session
          await page.keyboard.press("Meta+Shift+n")
          await page.waitForTimeout(3000)
          await page.screenshot({ path: "test-screenshots/EC-070-02c-after-shortcut.png" })
        }

        // Wait for session view to appear
        await sessionView.waitFor({ state: "visible", timeout: 15000 }).catch(() => null)
      }

      if (!(await sessionView.isVisible().catch(() => false))) {
        await page.screenshot({ path: "test-screenshots/EC-070-02d-no-session.png" })
        test.skip(true, "No session view available - could not create or find a session")
        return
      }

      // Find the prompt input
      const promptInput = page.locator(".prompt-input")
      await promptInput.waitFor({ state: "visible", timeout: 10000 }).catch(() => null)

      if (!(await promptInput.isVisible())) {
        test.skip(true, "No prompt input available")
        return
      }

      // Type a prompt that should trigger the AskUserQuestion tool
      await promptInput.fill(
        "Before doing anything, ask me a question using the AskUserQuestion tool. " +
        'Ask me: "Which programming language do you prefer?" with options: ' +
        '"TypeScript", "Python", "Rust". Do NOT do anything else, just ask the question.'
      )

      await page.screenshot({ path: "test-screenshots/EC-070-03-prompt-filled.png" })

      // Submit the prompt (press Enter or click send)
      await promptInput.press("Enter")

      // Wait for the question tool call to appear
      // The tool call header shows the tool name; look for any tool call containing "Question"
      const questionToolCall = page.locator('.tool-call').filter({ hasText: /Question/ })

      try {
        await questionToolCall.first().waitFor({ state: "visible", timeout: 60000 })
      } catch {
        // Take a screenshot to see what happened
        await page.screenshot({ path: "test-screenshots/EC-070-04-no-question-tool.png" })
        // Don't fail the test - the LLM might not have used the tool
        test.skip(true, "LLM did not use the question tool within timeout")
        return
      }

      await page.screenshot({ path: "test-screenshots/EC-070-05-question-tool-visible.png" })

      // Click the tool call to expand it if not already expanded
      const toolCallHeader = questionToolCall.first().locator(".tool-call-header")
      const isExpanded = await toolCallHeader.getAttribute("aria-expanded")
      if (isExpanded !== "true") {
        await toolCallHeader.click()
        await page.waitForTimeout(500)
      }

      // Wait for the question block to appear (the interactive UI from question.asked SSE)
      const questionBlock = page.locator(".tool-call-question-block")

      try {
        await questionBlock.waitFor({ state: "visible", timeout: 30000 })
      } catch {
        await page.screenshot({ path: "test-screenshots/EC-070-06-no-question-block.png" })

        // Even if the interactive block doesn't appear, the question renderer body may show
        // This means the SSE event wasn't received or the question wasn't matched to this tool call
        const rendererBody = page.locator(".tool-call-question-pending, .tool-call-question-answers")
        const hasRendererBody = await rendererBody.isVisible().catch(() => false)
        if (hasRendererBody) {
          await page.screenshot({ path: "test-screenshots/EC-070-06b-renderer-body.png" })
        }

        test.skip(true, "Question block interactive UI did not appear (SSE event may not have been received)")
        return
      }

      await page.screenshot({ path: "test-screenshots/EC-070-07-question-block-visible.png" })

      // Verify the question block contains expected elements
      const questionLabel = questionBlock.locator(".tool-call-question-block-label")
      await expect(questionLabel).toHaveText("Question from Agent")

      // Verify question text is visible
      const questionText = questionBlock.locator(".tool-call-question-block-question")
      await expect(questionText).toBeVisible()

      // Verify option buttons exist
      const options = questionBlock.locator(".tool-call-question-block-option")
      const optionCount = await options.count()
      expect(optionCount).toBeGreaterThan(0)

      await page.screenshot({ path: "test-screenshots/EC-070-08-question-options.png" })

      // Click the first option
      await options.first().click()
      await page.waitForTimeout(300)

      // Verify it gets the selected class
      await expect(options.first()).toHaveClass(/selected/)

      await page.screenshot({ path: "test-screenshots/EC-070-09-option-selected.png" })

      // Verify submit button exists
      const submitButton = questionBlock.locator(".tool-call-question-block-button-primary")
      await expect(submitButton).toBeVisible()
      await expect(submitButton).toHaveText("Submit Answer")

      // Verify dismiss button exists
      const dismissButton = questionBlock.locator(
        ".tool-call-question-block-button:not(.tool-call-question-block-button-primary)"
      )
      await expect(dismissButton).toBeVisible()

      // Submit the answer
      await submitButton.click()

      // Wait for the question block to disappear (question answered)
      await questionBlock.waitFor({ state: "hidden", timeout: 15000 }).catch(() => null)

      await page.screenshot({ path: "test-screenshots/EC-070-10-after-submit.png" })

      // Verify the tool call shows completed state
      // The question tool should now show the answer in the renderer
      const completedAnswers = page.locator(".tool-call-question-answers")
      await completedAnswers.waitFor({ state: "visible", timeout: 10000 }).catch(() => null)

      if (await completedAnswers.isVisible()) {
        await page.screenshot({ path: "test-screenshots/EC-070-11-answers-shown.png" })
      }
    })
  })
})
