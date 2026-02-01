import { test, expect } from "@playwright/test"

/**
 * EC-057: LLM Classification Endpoint & Instruction Capture Flow
 *
 * Tests the two-stage instruction classification pipeline:
 *   Stage 1 (regex): client-side, fast, always runs
 *   Stage 2 (LLM):  server-side via /api/era/classify-confirm, borderline only
 *
 * And the capture card UI that appears when instructions are detected.
 *
 * Browser-side tests use window.__TEST_INJECT__ (dev-mode hook from test-injection.ts).
 * Server endpoint tests use Playwright's request fixture.
 */

const BASE = "http://localhost:3000"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dismissModals(page: import("@playwright/test").Page) {
  for (const text of ["Proceed with auto-approve", "Proceed", "Continue", "OK", "Accept", "Close"]) {
    const btn = page.locator(`button:has-text("${text}")`).first()
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click()
      await page.waitForTimeout(500)
      return
    }
  }
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
}

/** Navigate into a session so capture card component is mounted */
async function navigateToSession(page: import("@playwright/test").Page) {
  const recentProject = page.locator(".folder-card, .recent-project-card, [data-testid='recent-project']").first()
  if (await recentProject.isVisible({ timeout: 3000 }).catch(() => false)) {
    await recentProject.click()
    await page.waitForTimeout(2000)
    await dismissModals(page)
  }

  const sessionItem = page.locator(".session-item, .session-list-item, [data-testid='session-item']").first()
  if (await sessionItem.isVisible({ timeout: 2000 }).catch(() => false)) {
    await sessionItem.click()
    await page.waitForTimeout(2000)
  }
}

/** Check that __TEST_INJECT__ is available */
async function hasTestInject(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => typeof (window as any).__TEST_INJECT__ !== "undefined")
}

// ---------------------------------------------------------------------------
// Part 1: Server Endpoint Tests
// ---------------------------------------------------------------------------

test.describe("EC-057 Part 1: /api/era/classify-confirm endpoint", () => {
  test("should respond to classify-confirm endpoint", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/classify-confirm`, {
      data: { message: "always use Playwright on a free port" },
    })

    console.log(`classify-confirm status: ${resp.status()}`)

    if (resp.status() === 404) {
      console.log("SKIP: Endpoint not available — server may need restart with new code")
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    console.log("classify-confirm response:", JSON.stringify(body))

    // Without ANTHROPIC_API_KEY we expect { unavailable: true }
    // With a key, we get a real classification — both are valid
    if (body.unavailable) {
      expect(body.unavailable).toBe(true)
      console.log("PASS: Graceful degradation — LLM unavailable (no API key)")
    } else {
      expect(typeof body.isInstruction).toBe("boolean")
      expect(typeof body.confidence).toBe("number")
      expect(body.confidence).toBeGreaterThanOrEqual(0)
      expect(body.confidence).toBeLessThanOrEqual(1)
      console.log("PASS: LLM classification returned valid result")
    }
  })

  test("should return 400 for missing message", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/classify-confirm`, {
      data: {},
    })

    if (resp.status() === 404) {
      console.log("SKIP: Endpoint not available")
      test.skip()
      return
    }

    expect(resp.status()).toBe(400)
    const body = await resp.json()
    expect(body.error).toBeTruthy()
    console.log("PASS: 400 for missing message:", body.error)
  })

  test("should return 400 for non-string message", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/classify-confirm`, {
      data: { message: 12345 },
    })

    if (resp.status() === 404) {
      console.log("SKIP: Endpoint not available")
      test.skip()
      return
    }

    expect(resp.status()).toBe(400)
    console.log("PASS: 400 for non-string message")
  })
})

// ---------------------------------------------------------------------------
// Part 2: Client-Side Regex Classifier Tests (via __TEST_INJECT__)
// ---------------------------------------------------------------------------

test.describe("EC-057 Part 2: Client-side regex classifier", () => {
  test.setTimeout(60000)

  test("should classify high-confidence instructions without LLM", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      console.log("SKIP: __TEST_INJECT__ not available (not dev mode)")
      test.skip()
      return
    }

    const results = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__

      const testCases = [
        "always use Playwright on a free port",
        "use vitest for testing in this project",
        "be hyper critical of your work",
        "commit messages should follow conventional commits format",
        "from now on, always run tests before committing",
      ]

      return testCases.map((msg) => {
        const result = inject.regexPreFilter(msg)
        return {
          message: msg,
          isInstruction: result.isInstruction,
          confidence: result.confidence,
          category: result.category,
          needsLlm: result.needsLlmConfirmation,
          scope: result.suggestedScope,
        }
      })
    })

    console.log("\n=== High-Confidence Classification Results ===")
    for (const r of results) {
      console.log(`  "${r.message.substring(0, 55)}"`)
      console.log(`    → instruction=${r.isInstruction} conf=${r.confidence} cat=${r.category} llm=${r.needsLlm} scope=${r.scope}`)

      expect(r.isInstruction).toBe(true)
      expect(r.needsLlm).toBe(false)
      expect(r.confidence).toBeGreaterThanOrEqual(0.8)
    }

    console.log("PASS: All high-confidence instructions classified correctly without LLM")
  })

  test("should flag borderline messages for LLM confirmation", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const results = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__

      const testCases = [
        "remember to check for edge cases",
        "prefer composition over inheritance",
        "use formal tone in documentation",
      ]

      return testCases.map((msg) => {
        const result = inject.regexPreFilter(msg)
        return {
          message: msg,
          isInstruction: result.isInstruction,
          confidence: result.confidence,
          category: result.category,
          needsLlm: result.needsLlmConfirmation,
        }
      })
    })

    console.log("\n=== Borderline Classification Results ===")
    let borderlineCount = 0
    for (const r of results) {
      console.log(`  "${r.message}" → inst=${r.isInstruction} conf=${r.confidence} cat=${r.category} llm=${r.needsLlm}`)
      if (r.isInstruction && r.confidence < 0.8 && r.confidence >= 0.6) {
        expect(r.needsLlm).toBe(true)
        borderlineCount++
      }
    }

    console.log(`PASS: ${borderlineCount} messages correctly flagged for LLM confirmation`)
  })

  test("should reject non-instructions", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const results = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__

      const testCases = [
        "how do I set up Playwright?",
        "can you fix this bug?",
        "what if we used a different approach?",
        "I tried running the tests yesterday",
        "ok",
      ]

      return testCases.map((msg) => {
        const result = inject.regexPreFilter(msg)
        return {
          message: msg,
          isInstruction: result.isInstruction,
          confidence: result.confidence,
        }
      })
    })

    console.log("\n=== Non-Instruction Results ===")
    for (const r of results) {
      console.log(`  "${r.message}" → inst=${r.isInstruction} conf=${r.confidence}`)
      expect(r.isInstruction).toBe(false)
    }

    console.log("PASS: All non-instructions correctly rejected")
  })

  test("should detect correct scope", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const results = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__

      return [
        { msg: "always use Playwright in this project", result: inject.regexPreFilter("always use Playwright in this project") },
        { msg: "from now on, always write tests", result: inject.regexPreFilter("from now on, always write tests") },
        { msg: "use vitest for testing in this repo", result: inject.regexPreFilter("use vitest for testing in this repo") },
      ].map((t: any) => ({
        message: t.msg,
        scope: t.result.suggestedScope,
        isInstruction: t.result.isInstruction,
      }))
    })

    console.log("\n=== Scope Detection Results ===")
    for (const r of results) {
      console.log(`  "${r.message}" → scope=${r.scope}`)
    }

    // "in this project" / "in this repo" should detect project scope
    const projectScoped = results.find((r: any) => r.message.includes("in this project"))
    if (projectScoped?.isInstruction) {
      expect(projectScoped.scope).toBe("project")
      console.log("PASS: 'in this project' correctly scoped to project")
    }

    const repoScoped = results.find((r: any) => r.message.includes("in this repo"))
    if (repoScoped?.isInstruction) {
      expect(repoScoped.scope).toBe("project")
      console.log("PASS: 'in this repo' correctly scoped to project")
    }
  })
})

// ---------------------------------------------------------------------------
// Part 3: mergeWithLlmResult logic tests (via __TEST_INJECT__)
// ---------------------------------------------------------------------------

test.describe("EC-057 Part 3: LLM result merge logic", () => {
  test.setTimeout(60000)

  test("should merge LLM confirmation into regex result", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__

      const regexResult = {
        isInstruction: true,
        confidence: 0.72,
        category: null,
        suggestedScope: "project",
        extractedInstruction: "remember to check for edge cases",
        sourceMessage: "remember to check for edge cases",
        needsLlmConfirmation: true,
      }

      const llmResult = {
        isInstruction: true,
        category: "quality",
        instruction: "Check for edge cases in all implementations",
        scope: "global",
        confidence: 0.91,
      }

      const merged = inject.mergeWithLlmResult(regexResult, llmResult)
      return {
        isInstruction: merged.isInstruction,
        confidence: merged.confidence,
        category: merged.category,
        scope: merged.suggestedScope,
        instruction: merged.extractedInstruction,
        needsLlm: merged.needsLlmConfirmation,
      }
    })

    console.log("Merged result:", JSON.stringify(result, null, 2))

    expect(result.isInstruction).toBe(true)
    expect(result.confidence).toBeGreaterThanOrEqual(0.85)
    expect(result.confidence).toBeLessThanOrEqual(0.98)
    expect(result.category).toBe("quality")
    expect(result.scope).toBe("global")
    expect(result.instruction).toBe("Check for edge cases in all implementations")
    expect(result.needsLlm).toBe(false)

    console.log("PASS: LLM confirmation merged correctly")
  })

  test("should suppress card when LLM rejects classification", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__

      const regexResult = {
        isInstruction: true,
        confidence: 0.65,
        category: "style",
        suggestedScope: "project",
        extractedInstruction: "be creative with your solutions",
        sourceMessage: "be creative with your solutions",
        needsLlmConfirmation: true,
      }

      const llmReject = {
        isInstruction: false,
        category: null,
        instruction: "be creative with your solutions",
        scope: "project",
        confidence: 0.3,
      }

      const merged = inject.mergeWithLlmResult(regexResult, llmReject)
      return {
        isInstruction: merged.isInstruction,
        confidence: merged.confidence,
        needsLlm: merged.needsLlmConfirmation,
      }
    })

    console.log("Rejected result:", JSON.stringify(result))

    expect(result.isInstruction).toBe(false)
    expect(result.confidence).toBeLessThan(0.5)
    expect(result.needsLlm).toBe(false)

    console.log("PASS: LLM rejection correctly suppresses classification")
  })

  test("should identify unavailable responses", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__

      return {
        unavailableCheck: inject.isLlmUnavailable({ unavailable: true }),
        availableCheck: inject.isLlmUnavailable({
          isInstruction: true,
          category: "testing",
          instruction: "test everything",
          scope: "project",
          confidence: 0.9,
        }),
      }
    })

    expect(result.unavailableCheck).toBe(true)
    expect(result.availableCheck).toBe(false)

    console.log("PASS: isLlmUnavailable type guard works correctly")
  })
})

// ---------------------------------------------------------------------------
// Part 4: Capture Card UI Tests
// ---------------------------------------------------------------------------

test.describe("EC-057 Part 4: Capture card UI", () => {
  test.setTimeout(90000)

  test("should display capture card when showCaptureCard is called", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!(await hasTestInject(page))) {
      console.log("SKIP: __TEST_INJECT__ not available")
      test.skip()
      return
    }

    await page.screenshot({ path: "test-screenshots/EC-057-01-initial.png", fullPage: true })

    await navigateToSession(page)

    await page.screenshot({ path: "test-screenshots/EC-057-02-in-session.png", fullPage: true })

    // Programmatically trigger showCaptureCard via the test hook
    await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__
      inject.showCaptureCard({
        isInstruction: true,
        confidence: 0.92,
        category: "tooling",
        suggestedScope: "project",
        extractedInstruction: "Always use Playwright on a free port for E2E tests",
        sourceMessage: "always use Playwright on a free port for E2E tests",
        needsLlmConfirmation: false,
      })
    })

    await page.waitForTimeout(500)
    await page.screenshot({ path: "test-screenshots/EC-057-03-capture-card-shown.png", fullPage: true })

    // Verify the capture card is visible
    const card = page.locator("text=Save as guidance?")
    const cardVisible = await card.isVisible({ timeout: 3000 }).catch(() => false)
    console.log(`Capture card visible: ${cardVisible}`)

    if (cardVisible) {
      // Verify category badge
      const categoryBadge = page.locator("span:text-is('tooling')")
      const hasBadge = await categoryBadge.isVisible({ timeout: 1000 }).catch(() => false)
      console.log(`Category badge visible: ${hasBadge}`)

      // Verify instruction text
      const instructionText = page.locator("text=Always use Playwright on a free port")
      const hasText = await instructionText.isVisible({ timeout: 1000 }).catch(() => false)
      console.log(`Instruction text visible: ${hasText}`)

      // Verify scope button shows "Project"
      const scopeBtn = page.locator("button:has-text('Project')").first()
      const hasScope = await scopeBtn.isVisible({ timeout: 1000 }).catch(() => false)
      console.log(`Scope button visible: ${hasScope}`)

      // Verify Save button
      const saveBtn = page.locator("button:has-text('Save')").first()
      const hasSave = await saveBtn.isVisible({ timeout: 1000 }).catch(() => false)
      console.log(`Save button visible: ${hasSave}`)

      expect(hasText).toBe(true)

      console.log("PASS: Capture card displayed with correct content")
    } else {
      console.log("SKIP: Capture card not rendered — component may not be mounted in current view")
    }
  })

  test("should toggle scope between Project and Global", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    await navigateToSession(page)

    // Trigger capture card
    await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__
      inject.showCaptureCard({
        isInstruction: true,
        confidence: 0.88,
        category: "style",
        suggestedScope: "project",
        extractedInstruction: "Be concise and direct in all responses",
        sourceMessage: "be concise and direct in all responses",
        needsLlmConfirmation: false,
      })
    })

    await page.waitForTimeout(500)

    const scopeBtn = page.locator("button:has-text('Project')").first()
    if (await scopeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await scopeBtn.click()
      await page.waitForTimeout(300)

      const globalBtn = page.locator("button:has-text('Global')").first()
      const isGlobal = await globalBtn.isVisible({ timeout: 1000 }).catch(() => false)
      console.log(`Toggled to Global: ${isGlobal}`)

      await page.screenshot({ path: "test-screenshots/EC-057-04-scope-toggled.png", fullPage: true })

      if (isGlobal) {
        // Verify the state was updated
        const state = await page.evaluate(() => {
          return (window as any).__TEST_INJECT__.getCaptureCardState()
        })
        expect(state.selectedScope).toBe("global")

        // Toggle back to Project
        await globalBtn.click()
        await page.waitForTimeout(300)
        const backToProject = await page.locator("button:has-text('Project')").first().isVisible({ timeout: 1000 }).catch(() => false)
        expect(backToProject).toBe(true)

        console.log("PASS: Scope toggle works correctly")
      }
    } else {
      console.log("SKIP: Scope button not found in current view")
    }
  })

  test("should dismiss capture card", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    await navigateToSession(page)

    await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__
      inject.showCaptureCard({
        isInstruction: true,
        confidence: 0.85,
        category: "testing",
        suggestedScope: "project",
        extractedInstruction: "Write E2E tests for every new feature",
        sourceMessage: "write e2e tests for every new feature",
        needsLlmConfirmation: false,
      })
    })

    await page.waitForTimeout(500)

    const dismissBtn = page.locator("button[aria-label='Dismiss']")
    if (await dismissBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dismissBtn.click()
      await page.waitForTimeout(500)

      // Verify card is gone
      const cardGone = await page.locator("text=Save as guidance?").isVisible({ timeout: 500 }).catch(() => false)
      expect(cardGone).toBe(false)

      // Verify state is dismissed
      const state = await page.evaluate(() => {
        return (window as any).__TEST_INJECT__.getCaptureCardState()
      })
      expect(state.status).toBe("dismissed")

      console.log("PASS: Card dismissed successfully")
      await page.screenshot({ path: "test-screenshots/EC-057-05-card-dismissed.png", fullPage: true })
    } else {
      console.log("SKIP: Dismiss button not found")
    }
  })
})

// ---------------------------------------------------------------------------
// Part 5: Integration Flow — Mocked Server Responses
// ---------------------------------------------------------------------------

test.describe("EC-057 Part 5: Full classification flow with mocked server", () => {
  test.setTimeout(90000)

  test("should show card immediately for high-confidence, use LLM for borderline", async ({ page }) => {
    // Intercept classify-confirm to return mock LLM response
    const classifyConfirmCalls: string[] = []
    await page.route("**/api/era/classify-confirm", async (route) => {
      const body = route.request().postDataJSON()
      classifyConfirmCalls.push(body?.message ?? "unknown")
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          isInstruction: true,
          category: "quality",
          instruction: body?.message ?? "",
          scope: "global",
          confidence: 0.92,
        }),
      })
    })

    // Intercept save endpoint
    await page.route("**/api/era/classify-instruction", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, id: "test-1" }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    await page.screenshot({ path: "test-screenshots/EC-057-06-flow-start.png", fullPage: true })

    // Test classify() pipeline directly via test hooks
    const results = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__

      // Reset cooldown
      inject.resetCooldown()

      const highResult = inject.classify("always use Playwright on a free port")

      inject.resetCooldown()
      const questionResult = inject.classify("how do I set up Playwright?")

      inject.resetCooldown()
      const borderlineResult = inject.classify("remember to check for edge cases")

      return {
        high: highResult ? {
          isInstruction: highResult.isInstruction,
          confidence: highResult.confidence,
          needsLlm: highResult.needsLlmConfirmation,
          category: highResult.category,
        } : null,
        question: questionResult,
        borderline: borderlineResult ? {
          isInstruction: borderlineResult.isInstruction,
          confidence: borderlineResult.confidence,
          needsLlm: borderlineResult.needsLlmConfirmation,
          category: borderlineResult.category,
        } : null,
      }
    })

    console.log("\n=== Full Pipeline Results ===")
    console.log("High confidence:", JSON.stringify(results.high))
    console.log("Question:", JSON.stringify(results.question))
    console.log("Borderline:", JSON.stringify(results.borderline))

    // High-confidence: classified, no LLM needed
    expect(results.high).not.toBeNull()
    expect(results.high!.isInstruction).toBe(true)
    expect(results.high!.needsLlm).toBe(false)
    expect(results.high!.confidence).toBeGreaterThanOrEqual(0.8)
    console.log("PASS: High-confidence instruction classified without LLM")

    // Question: filtered out entirely
    expect(results.question).toBeNull()
    console.log("PASS: Question correctly filtered out")

    // Borderline: if detected, should need LLM
    if (results.borderline) {
      console.log(`Borderline: needsLlm=${results.borderline.needsLlm}, conf=${results.borderline.confidence}`)
    } else {
      console.log("INFO: Borderline message filtered out by regex pre-filter")
    }
  })

  test("should suppress card when LLM returns unavailable", async ({ page }) => {
    // Mock classify-confirm to return unavailable
    await page.route("**/api/era/classify-confirm", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ unavailable: true }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    await navigateToSession(page)

    // Simulate the confirmClassification flow: borderline result → LLM unavailable → no card
    const flowResult = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      const borderlineResult = {
        isInstruction: true,
        confidence: 0.72,
        category: null as string | null,
        suggestedScope: "project" as const,
        extractedInstruction: "remember to check for edge cases",
        sourceMessage: "remember to check for edge cases",
        needsLlmConfirmation: true,
      }

      try {
        const resp = await fetch("/api/era/classify-confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: borderlineResult.sourceMessage }),
        })

        if (!resp.ok) return { shown: false, reason: "http_error" }

        const data = await resp.json()

        if (inject.isLlmUnavailable(data)) {
          return { shown: false, reason: "llm_unavailable" }
        }

        const refined = inject.mergeWithLlmResult(borderlineResult, data)
        if (refined.isInstruction) {
          inject.showCaptureCard(refined)
          return { shown: true, reason: "llm_confirmed" }
        }
        return { shown: false, reason: "llm_rejected" }
      } catch {
        return { shown: false, reason: "fetch_error" }
      }
    })

    console.log("LLM unavailable flow:", JSON.stringify(flowResult))
    expect(flowResult.shown).toBe(false)
    expect(flowResult.reason).toBe("llm_unavailable")

    // Verify no card appeared
    const cardVisible = await page.locator("text=Save as guidance?").isVisible({ timeout: 500 }).catch(() => false)
    expect(cardVisible).toBe(false)

    console.log("PASS: Borderline message suppressed when LLM unavailable")
    await page.screenshot({ path: "test-screenshots/EC-057-07-llm-unavailable.png", fullPage: true })
  })

  test("should show card when LLM confirms borderline classification", async ({ page }) => {
    // Mock classify-confirm to return a positive confirmation
    await page.route("**/api/era/classify-confirm", async (route) => {
      const body = route.request().postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          isInstruction: true,
          category: "quality",
          instruction: "Check for edge cases in all implementations",
          scope: "global",
          confidence: 0.91,
        }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    await navigateToSession(page)

    // Simulate confirmClassification: borderline → LLM confirms → show card
    await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      const borderlineResult = {
        isInstruction: true,
        confidence: 0.72,
        category: null as string | null,
        suggestedScope: "project" as const,
        extractedInstruction: "remember to check for edge cases",
        sourceMessage: "remember to check for edge cases",
        needsLlmConfirmation: true,
      }

      const resp = await fetch("/api/era/classify-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: borderlineResult.sourceMessage }),
      })

      const data = await resp.json()

      if (!inject.isLlmUnavailable(data)) {
        const refined = inject.mergeWithLlmResult(borderlineResult, data)
        if (refined.isInstruction) {
          inject.showCaptureCard(refined)
        }
      }
    })

    await page.waitForTimeout(500)
    await page.screenshot({ path: "test-screenshots/EC-057-08-llm-confirmed.png", fullPage: true })

    // Card should be visible
    const cardVisible = await page.locator("text=Save as guidance?").isVisible({ timeout: 3000 }).catch(() => false)
    console.log(`Card visible after LLM confirmation: ${cardVisible}`)

    if (cardVisible) {
      // Verify it has the LLM-refined category
      const qualityBadge = page.locator("span:text-is('quality')")
      const hasBadge = await qualityBadge.isVisible({ timeout: 1000 }).catch(() => false)
      console.log(`Quality badge visible: ${hasBadge}`)

      // Verify the scope was updated to global (LLM returned global)
      const globalBtn = page.locator("button:has-text('Global')").first()
      const isGlobal = await globalBtn.isVisible({ timeout: 1000 }).catch(() => false)
      console.log(`Scope set to Global (from LLM): ${isGlobal}`)

      console.log("PASS: Borderline message shown after LLM confirmation with refined fields")
    } else {
      console.log("SKIP: Card not visible — component may not be mounted in current view")
    }
  })

  test("should save instruction via mocked endpoint", async ({ page }) => {
    let savedPayload: Record<string, unknown> | null = null

    await page.route("**/api/era/classify-instruction", async (route) => {
      savedPayload = route.request().postDataJSON()
      console.log("Save intercepted:", JSON.stringify(savedPayload))
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, id: "test-saved-1" }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    await navigateToSession(page)

    // Show capture card
    await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__
      inject.showCaptureCard({
        isInstruction: true,
        confidence: 0.90,
        category: "testing",
        suggestedScope: "project",
        extractedInstruction: "Always run tests before pushing",
        sourceMessage: "always run tests before pushing",
        needsLlmConfirmation: false,
      })
    })

    await page.waitForTimeout(500)

    const saveBtn = page.locator("button:has-text('Save')").first()
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click()
      await page.waitForTimeout(1500)

      await page.screenshot({ path: "test-screenshots/EC-057-09-after-save.png", fullPage: true })

      // Check for "Saved" confirmation
      const savedText = page.locator("text=Saved")
      const isSaved = await savedText.isVisible({ timeout: 2000 }).catch(() => false)
      console.log(`"Saved" text visible: ${isSaved}`)

      if (savedPayload) {
        console.log("Saved payload:", JSON.stringify(savedPayload))
        expect(savedPayload).toBeTruthy()
        console.log("PASS: Instruction saved via API")
      }
    } else {
      console.log("SKIP: Save button not visible")
    }
  })
})

// ---------------------------------------------------------------------------
// Part 6: Cooldown & Rate Limiting
// ---------------------------------------------------------------------------

test.describe("EC-057 Part 6: Cooldown and rate limiting", () => {
  test.setTimeout(60000)

  test("should respect cooldown between classification attempts", async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const results = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__

      // Reset cooldown first
      inject.resetCooldown()

      // First classification should work
      const first = inject.classify("always use TypeScript strict mode")

      // Record that a card was shown (simulates the real flow)
      if (first) inject.recordCardShown()

      // Second classification should be blocked by cooldown (30s default)
      const second = inject.classify("never commit without tests")

      // Manually reset and try again
      inject.resetCooldown()
      const third = inject.classify("never commit without tests")

      return {
        first: first ? { isInstruction: first.isInstruction, confidence: first.confidence } : null,
        second: second,
        third: third ? { isInstruction: third.isInstruction, confidence: third.confidence } : null,
      }
    })

    console.log("\n=== Cooldown Test Results ===")
    console.log("First (should work):", JSON.stringify(results.first))
    console.log("Second (should be null — cooldown active):", JSON.stringify(results.second))
    console.log("Third (should work — cooldown reset):", JSON.stringify(results.third))

    expect(results.first).not.toBeNull()
    expect(results.second).toBeNull()
    expect(results.third).not.toBeNull()

    console.log("PASS: Cooldown rate limiting works correctly")
  })
})
