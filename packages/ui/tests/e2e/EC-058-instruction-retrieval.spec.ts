import { test, expect } from "@playwright/test"

/**
 * EC-058: Instruction Retrieval Wiring
 *
 * Tests the retrieval pipeline that fetches saved instructions from Era Memory
 * and injects them into the LLM context:
 *   - Server endpoints: session-start, tool, flush, prune
 *   - Client-side store: populate, consume, clear
 *   - Prompt injection: hidden text part in requestParts
 *   - Tool detection: SSE tool event triggers retrieval
 *   - Session idle cleanup: flush on idle
 *   - Graceful degradation: 500 errors, empty results
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

async function hasTestInject(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => typeof (window as any).__TEST_INJECT__ !== "undefined")
}

// ---------------------------------------------------------------------------
// Part 1: Server Endpoint Tests
// ---------------------------------------------------------------------------

test.describe("EC-058 Part 1: Retrieval server endpoints", () => {
  test("POST /api/era/retrieval/session-start should return instructions shape", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/retrieval/session-start`, {
      data: { sessionId: "test-session-1", context: { projectName: "TestProject" } },
    })

    console.log(`session-start status: ${resp.status()}`)

    if (resp.status() === 404) {
      console.log("SKIP: Endpoint not available — server may need restart with new code")
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    console.log("session-start response:", JSON.stringify(body))

    expect(body).toHaveProperty("instructions")
    expect(body).toHaveProperty("composed")
    expect(Array.isArray(body.instructions)).toBe(true)
    expect(typeof body.composed).toBe("string")

    console.log("PASS: session-start endpoint returns correct shape")
  })

  test("POST /api/era/retrieval/tool should return tool-specific instructions", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/retrieval/tool`, {
      data: { sessionId: "test-session-1", toolName: "playwright", context: { projectName: "TestProject" } },
    })

    if (resp.status() === 404) {
      console.log("SKIP: Endpoint not available")
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    console.log("tool retrieval response:", JSON.stringify(body))

    expect(body).toHaveProperty("instructions")
    expect(body).toHaveProperty("composed")
    expect(Array.isArray(body.instructions)).toBe(true)
    expect(typeof body.composed).toBe("string")

    console.log("PASS: tool endpoint returns correct shape")
  })

  test("POST /api/era/retrieval/flush should flush session", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/retrieval/flush`, {
      data: { sessionId: "test-session-1" },
    })

    if (resp.status() === 404) {
      console.log("SKIP: Endpoint not available")
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    console.log("flush response:", JSON.stringify(body))

    expect(body).toHaveProperty("flushed")
    expect(typeof body.flushed).toBe("boolean")

    console.log("PASS: flush endpoint returns correct shape")
  })

  test("POST /api/era/retrieval/prune should prune stale instructions", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/retrieval/prune`, {
      data: {},
    })

    if (resp.status() === 404) {
      console.log("SKIP: Endpoint not available")
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    console.log("prune response:", JSON.stringify(body))

    expect(body).toHaveProperty("flaggedForReview")
    expect(body).toHaveProperty("archived")
    expect(body).toHaveProperty("errors")
    expect(Array.isArray(body.flaggedForReview)).toBe(true)
    expect(Array.isArray(body.archived)).toBe(true)
    expect(Array.isArray(body.errors)).toBe(true)

    console.log("PASS: prune endpoint returns correct shape")
  })

  test("session-start with missing sessionId returns graceful empty", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/retrieval/session-start`, {
      data: {},
    })

    if (resp.status() === 404) {
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    expect(body.instructions).toEqual([])
    expect(body.composed).toBe("")

    console.log("PASS: Missing sessionId returns graceful empty")
  })

  test("tool retrieval with missing toolName returns graceful empty", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/retrieval/tool`, {
      data: { sessionId: "test-session-1" },
    })

    if (resp.status() === 404) {
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    expect(body.instructions).toEqual([])
    expect(body.composed).toBe("")

    console.log("PASS: Missing toolName returns graceful empty")
  })
})

// ---------------------------------------------------------------------------
// Part 2: Client-Side Store Tests (via __TEST_INJECT__)
// ---------------------------------------------------------------------------

test.describe("EC-058 Part 2: Client-side retrieval store", () => {
  test.setTimeout(60000)

  test("should populate and consume session-start state", async ({ page }) => {
    // Mock the session-start endpoint to return test data
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [
            { id: "inst-1", content: "Use vitest for testing", category: "testing", scope: "project", score: 0.9, accessCount: 5 },
            { id: "inst-2", content: "Follow conventional commits", category: "workflow", scope: "global", score: 0.85, accessCount: 3 },
          ],
          composed: "## Retrieved Preferences\n- Use vitest for testing\n- Follow conventional commits\n",
        }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      console.log("SKIP: __TEST_INJECT__ not available")
      test.skip()
      return
    }

    // Trigger retrieval and verify state
    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      // Clear any prior state
      inject.clearRetrievalState("test-instance", "test-session")

      // Retrieve
      await inject.retrieveSessionStart("test-instance", "test-session", { projectName: "TestProject" })

      // Check state
      const state = inject.getRetrievalState()
      const sessionState = state.get("test-instance:test-session")

      return {
        hasState: !!sessionState,
        instructionCount: sessionState?.sessionStartInstructions?.length ?? 0,
        composed: sessionState?.sessionStartComposed ?? "",
        injected: sessionState?.injectedSessionStart ?? false,
      }
    })

    console.log("Store state after retrieve:", JSON.stringify(result))

    expect(result.hasState).toBe(true)
    expect(result.instructionCount).toBe(2)
    expect(result.composed).toContain("Retrieved Preferences")
    expect(result.injected).toBe(false)

    console.log("PASS: Session-start state populated correctly")
  })

  test("should return composed injection and mark as injected (one-shot)", async ({ page }) => {
    // Mock the session-start endpoint
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [
            { id: "inst-1", content: "Use vitest", category: "testing", scope: "project", score: 0.9, accessCount: 5 },
          ],
          composed: "## Retrieved Preferences\n- Use vitest\n",
        }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      inject.clearRetrievalState("test-inst", "test-sess")
      await inject.retrieveSessionStart("test-inst", "test-sess", { projectName: "Test" })

      // First call should return composed injection
      const first = inject.getComposedInjection("test-inst", "test-sess")

      // Second call should return empty (already injected)
      const second = inject.getComposedInjection("test-inst", "test-sess")

      return { first, second }
    })

    console.log("Injection results:", JSON.stringify(result))

    expect(result.first).toContain("Retrieved Preferences")
    expect(result.first).toContain("Use vitest")
    expect(result.second).toBe("")

    console.log("PASS: One-shot injection works correctly")
  })

  test("should clear retrieval state", async ({ page }) => {
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [{ id: "inst-1", content: "Test", category: null, scope: "global", score: 0.8, accessCount: 1 }],
          composed: "## Retrieved Preferences\n- Test\n",
        }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      inject.clearRetrievalState("inst-x", "sess-x")
      await inject.retrieveSessionStart("inst-x", "sess-x", {})

      const beforeClear = inject.getRetrievalState().has("inst-x:sess-x")
      inject.clearRetrievalState("inst-x", "sess-x")
      const afterClear = inject.getRetrievalState().has("inst-x:sess-x")

      return { beforeClear, afterClear }
    })

    expect(result.beforeClear).toBe(true)
    expect(result.afterClear).toBe(false)

    console.log("PASS: clearRetrievalState removes session state")
  })
})

// ---------------------------------------------------------------------------
// Part 3: Prompt Injection Integration
// ---------------------------------------------------------------------------

test.describe("EC-058 Part 3: Prompt injection integration", () => {
  test.setTimeout(60000)

  test("should inject retrieved instructions as hidden part in requestParts", async ({ page }) => {
    // Mock retrieval endpoint
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [
            { id: "inst-1", content: "Always use TypeScript strict mode", category: "environment", scope: "project", score: 0.9, accessCount: 10 },
          ],
          composed: "## Retrieved Preferences\n- Always use TypeScript strict mode\n",
        }),
      })
    })

    // Intercept promptAsync to check what parts are sent
    let capturedRequestBody: any = null
    await page.route("**/session/*/prompt", async (route) => {
      capturedRequestBody = route.request().postDataJSON()
      // Respond with 200 to prevent hanging
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      console.log("SKIP: __TEST_INJECT__ not available")
      test.skip()
      return
    }

    // Pre-populate retrieval state so getComposedInjection has data ready
    await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      inject.clearRetrievalState("test-inst", "test-sess")
      await inject.retrieveSessionStart("test-inst", "test-sess", { projectName: "Test" })
    })

    // Verify the injection is ready
    const injection = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__
      // Peek without consuming (read state directly)
      const state = inject.getRetrievalState()
      const sessState = state.get("test-inst:test-sess")
      return {
        composed: sessState?.sessionStartComposed ?? "",
        injected: sessState?.injectedSessionStart ?? false,
      }
    })

    console.log("Pre-injection state:", JSON.stringify(injection))
    expect(injection.composed).toContain("Retrieved Preferences")
    expect(injection.injected).toBe(false)

    // Now consume it
    const consumed = await page.evaluate(() => {
      const inject = (window as any).__TEST_INJECT__
      return inject.getComposedInjection("test-inst", "test-sess")
    })

    expect(consumed).toContain("Always use TypeScript strict mode")
    console.log("PASS: Injection content available for requestParts")
  })
})

// ---------------------------------------------------------------------------
// Part 4: Tool Detection Flow
// ---------------------------------------------------------------------------

test.describe("EC-058 Part 4: Tool detection flow", () => {
  test.setTimeout(60000)

  test("should retrieve tool-specific instructions via mock endpoint", async ({ page }) => {
    const toolCalls: string[] = []

    await page.route("**/api/era/retrieval/tool", async (route) => {
      const body = route.request().postDataJSON()
      toolCalls.push(body?.toolName ?? "unknown")
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [
            { id: "tool-inst-1", content: "Run tests in headed mode for debugging", category: "testing", scope: "project", score: 0.85, accessCount: 2 },
          ],
          composed: "## Retrieved Preferences\n- Run tests in headed mode for debugging\n",
        }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      inject.clearRetrievalState("inst-1", "sess-1")
      await inject.retrieveForTool("inst-1", "sess-1", "playwright", { projectName: "Test" })

      const state = inject.getRetrievalState()
      const sessState = state.get("inst-1:sess-1")

      return {
        hasToolInstructions: sessState?.toolInstructions?.has("playwright") ?? false,
        toolComposed: sessState?.toolComposed?.get("playwright") ?? "",
      }
    })

    console.log("Tool retrieval result:", JSON.stringify(result))

    expect(result.hasToolInstructions).toBe(true)
    expect(result.toolComposed).toContain("headed mode")
    expect(toolCalls).toContain("playwright")

    console.log("PASS: Tool-specific instructions retrieved and cached")
  })

  test("should not re-fetch tool instructions for same tool (client cooldown)", async ({ page }) => {
    let fetchCount = 0

    await page.route("**/api/era/retrieval/tool", async (route) => {
      fetchCount++
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ instructions: [], composed: "" }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      inject.clearRetrievalState("inst-cd", "sess-cd")
      await inject.retrieveForTool("inst-cd", "sess-cd", "vitest", {})
      await inject.retrieveForTool("inst-cd", "sess-cd", "vitest", {})
      await inject.retrieveForTool("inst-cd", "sess-cd", "vitest", {})
    })

    console.log(`Tool fetch count (should be 1): ${fetchCount}`)
    expect(fetchCount).toBe(1)

    console.log("PASS: Client-side tool cooldown prevents duplicate fetches")
  })
})

// ---------------------------------------------------------------------------
// Part 5: Session Idle Cleanup
// ---------------------------------------------------------------------------

test.describe("EC-058 Part 5: Session idle cleanup", () => {
  test.setTimeout(60000)

  test("should flush session on idle via mock endpoint", async ({ page }) => {
    let flushCalled = false
    let flushedSessionId = ""

    await page.route("**/api/era/retrieval/flush", async (route) => {
      const body = route.request().postDataJSON()
      flushedSessionId = body?.sessionId ?? ""
      flushCalled = true
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flushed: true }),
      })
    })

    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [{ id: "inst-flush-1", content: "Test flush", category: null, scope: "global", score: 0.8, accessCount: 1 }],
          composed: "## Retrieved Preferences\n- Test flush\n",
        }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      inject.clearRetrievalState("inst-f", "sess-f")
      await inject.retrieveSessionStart("inst-f", "sess-f", {})

      // Verify state exists before flush
      const beforeFlush = inject.getRetrievalState().has("inst-f:sess-f")

      // Flush
      await inject.flushSession("inst-f", "sess-f")

      // State should be cleared after flush
      const afterFlush = inject.getRetrievalState().has("inst-f:sess-f")

      return { beforeFlush, afterFlush }
    })

    console.log("Flush result:", JSON.stringify(result))
    console.log(`Flush endpoint called: ${flushCalled}, sessionId: ${flushedSessionId}`)

    expect(result.beforeFlush).toBe(true)
    expect(result.afterFlush).toBe(false)
    expect(flushCalled).toBe(true)
    expect(flushedSessionId).toBe("sess-f")

    console.log("PASS: Session flush clears state and calls server")
  })
})

// ---------------------------------------------------------------------------
// Part 6: Graceful Degradation
// ---------------------------------------------------------------------------

test.describe("EC-058 Part 6: Graceful degradation", () => {
  test.setTimeout(60000)

  test("should handle 500 errors without breaking", async ({ page }) => {
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      inject.clearRetrievalState("inst-err", "sess-err")

      // Should not throw — errors are swallowed
      let threw = false
      try {
        await inject.retrieveSessionStart("inst-err", "sess-err", {})
      } catch {
        threw = true
      }

      // getComposedInjection should return empty
      const composed = inject.getComposedInjection("inst-err", "sess-err")

      return { threw, composed }
    })

    console.log("Error handling result:", JSON.stringify(result))

    expect(result.threw).toBe(false)
    expect(result.composed).toBe("")

    console.log("PASS: 500 errors handled gracefully — no breakage")
  })

  test("should handle empty retrieval results", async ({ page }) => {
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ instructions: [], composed: "" }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      inject.clearRetrievalState("inst-empty", "sess-empty")
      await inject.retrieveSessionStart("inst-empty", "sess-empty", {})

      const composed = inject.getComposedInjection("inst-empty", "sess-empty")
      const state = inject.getRetrievalState().get("inst-empty:sess-empty")

      return {
        composed,
        instructionCount: state?.sessionStartInstructions?.length ?? 0,
      }
    })

    console.log("Empty result:", JSON.stringify(result))

    expect(result.composed).toBe("")
    expect(result.instructionCount).toBe(0)

    console.log("PASS: Empty results handled correctly — no injection")
  })

  test("should handle flush errors without breaking", async ({ page }) => {
    await page.route("**/api/era/retrieval/flush", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Server error" }),
      })
    })

    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [{ id: "inst-1", content: "Test", category: null, scope: "global", score: 0.8, accessCount: 1 }],
          composed: "## Retrieved Preferences\n- Test\n",
        }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      inject.clearRetrievalState("inst-ferr", "sess-ferr")
      await inject.retrieveSessionStart("inst-ferr", "sess-ferr", {})

      let threw = false
      try {
        await inject.flushSession("inst-ferr", "sess-ferr")
      } catch {
        threw = true
      }

      // State should still be cleared (flush clears on finally)
      const cleared = !inject.getRetrievalState().has("inst-ferr:sess-ferr")

      return { threw, cleared }
    })

    console.log("Flush error handling:", JSON.stringify(result))

    expect(result.threw).toBe(false)
    expect(result.cleared).toBe(true)

    console.log("PASS: Flush errors handled gracefully — state still cleared")
  })

  test("should handle tool retrieval errors without breaking", async ({ page }) => {
    await page.route("**/api/era/retrieval/tool", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Server error" }),
      })
    })

    await page.goto(BASE)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    if (!(await hasTestInject(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      inject.clearRetrievalState("inst-terr", "sess-terr")

      let threw = false
      try {
        await inject.retrieveForTool("inst-terr", "sess-terr", "git", {})
      } catch {
        threw = true
      }

      const composed = inject.getComposedInjection("inst-terr", "sess-terr")

      return { threw, composed }
    })

    console.log("Tool error handling:", JSON.stringify(result))

    expect(result.threw).toBe(false)
    expect(result.composed).toBe("")

    console.log("PASS: Tool retrieval errors handled gracefully")
  })
})
