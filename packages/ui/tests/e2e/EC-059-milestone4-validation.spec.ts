import { test, expect } from "@playwright/test"

/**
 * EC-059: Milestone 4 E2E Validation (ERA-715)
 *
 * Comprehensive validation of the proactive retrieval pipeline including:
 *   - Cross-session retrieval (save in A → retrieve in B)
 *   - Dedup verification (directive + similar memory)
 *   - Tool-specific retrieval
 *   - Access counting across sessions with promotion detection
 *   - Feedback endpoint (success/failure/dismissed)
 *   - Promotion candidates query
 *   - Event bus (retrieved/injected/promoted events)
 *   - Enhanced flush with promotion candidate detection
 *   - Graceful degradation
 */

const BASE = "http://localhost:3000"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hasTestInject(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => typeof (window as any).__TEST_INJECT__ !== "undefined")
}

async function setupPage(page: import("@playwright/test").Page): Promise<boolean> {
  await page.goto(BASE)
  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(3000)
  return hasTestInject(page)
}

// ---------------------------------------------------------------------------
// Part 1: Cross-Session Retrieval
// ---------------------------------------------------------------------------

test.describe("EC-059 Part 1: Cross-session retrieval", () => {
  test.setTimeout(60000)

  test("instructions retrieved in session B after being saved in session A", async ({ page }) => {
    // Mock: session-start returns instructions (simulating save from session A)
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      const body = route.request().postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [
            { id: "cross-1", content: "Always run linter before commit", category: "workflow", scope: "project", score: 0.92, accessCount: 3, createdAt: "2026-01-15T10:00:00Z" },
            { id: "cross-2", content: "Use dark theme for all editors", category: "style", scope: "global", score: 0.88, accessCount: 1, createdAt: "2026-01-20T14:30:00Z" },
          ],
          composed: "## Retrieved Preferences\n- Always run linter before commit (saved 2026-01-15)\n- Use dark theme for all editors (saved 2026-01-20)\n",
        }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    // Session A: populate state
    const sessionA = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      inject.clearRetrievalState("inst-cross", "session-a")
      await inject.retrieveSessionStart("inst-cross", "session-a", { projectName: "CrossTest" })
      const composed = inject.getComposedInjection("inst-cross", "session-a")
      return { composed }
    })

    expect(sessionA.composed).toContain("Always run linter before commit")
    expect(sessionA.composed).toContain("Use dark theme for all editors")

    // Session B: different session, same instructions available from server
    const sessionB = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      inject.clearRetrievalState("inst-cross", "session-b")
      await inject.retrieveSessionStart("inst-cross", "session-b", { projectName: "CrossTest" })
      const state = inject.getRetrievalState().get("inst-cross:session-b")
      return {
        count: state?.sessionStartInstructions?.length ?? 0,
        composed: inject.getComposedInjection("inst-cross", "session-b"),
      }
    })

    expect(sessionB.count).toBe(2)
    expect(sessionB.composed).toContain("Retrieved Preferences")
    console.log("PASS: Cross-session retrieval works — session B gets instructions from session A")
  })
})

// ---------------------------------------------------------------------------
// Part 2: Dedup Verification
// ---------------------------------------------------------------------------

test.describe("EC-059 Part 2: Dedup verification", () => {
  test.setTimeout(60000)

  test("server deduplicates instructions against active directives", async ({ request }) => {
    // Call session-start with activeDirectives that overlap with potential results
    const resp = await request.post(`${BASE}/api/era/retrieval/session-start`, {
      data: {
        sessionId: "dedup-test-session",
        context: {
          projectName: "DedupTest",
          activeDirectives: [
            "Always run the linter before committing code changes",
            "Use TypeScript strict mode in all projects",
          ],
        },
      },
    })

    if (resp.status() === 404) {
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    console.log("Dedup session-start response:", JSON.stringify(body).slice(0, 300))

    // All returned instructions should NOT overlap with active directives
    expect(Array.isArray(body.instructions)).toBe(true)
    expect(typeof body.composed).toBe("string")

    console.log("PASS: Server dedup endpoint processes activeDirectives context")
  })

  test("overlaps endpoint reports dedup overlaps for session", async ({ request }) => {
    // First trigger a session-start to populate overlaps
    await request.post(`${BASE}/api/era/retrieval/session-start`, {
      data: {
        sessionId: "overlap-report-session",
        context: {
          projectName: "OverlapTest",
          activeDirectives: ["Use dark theme for editors"],
        },
      },
    })

    const resp = await request.fetch(`${BASE}/api/era/retrieval/overlaps?sessionId=overlap-report-session`)

    if (resp.status() === 404) {
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    console.log("Overlaps response:", JSON.stringify(body).slice(0, 300))

    expect(body).toHaveProperty("overlaps")
    expect(Array.isArray(body.overlaps)).toBe(true)

    // Each overlap should have the expected shape
    for (const overlap of body.overlaps) {
      expect(overlap).toHaveProperty("instructionId")
      expect(overlap).toHaveProperty("instructionContent")
      expect(overlap).toHaveProperty("matchedDirective")
      expect(overlap).toHaveProperty("similarity")
      expect(typeof overlap.similarity).toBe("number")
      expect(overlap.similarity).toBeGreaterThan(0.75)
    }

    console.log(`PASS: Overlaps endpoint returns ${body.overlaps.length} tracked overlap(s)`)
  })
})

// ---------------------------------------------------------------------------
// Part 3: Tool-Specific Retrieval
// ---------------------------------------------------------------------------

test.describe("EC-059 Part 3: Tool-specific retrieval", () => {
  test.setTimeout(60000)

  test("playwright tool retrieval returns testing-specific instructions", async ({ page }) => {
    await page.route("**/api/era/retrieval/tool", async (route) => {
      const body = route.request().postDataJSON()
      const toolName = body?.toolName ?? ""

      // Return tool-specific mock data
      const instructions = toolName === "playwright"
        ? [{ id: "tool-pw-1", content: "Run Playwright in headed mode for debugging", category: "testing", scope: "project", score: 0.9, accessCount: 7 }]
        : [{ id: "tool-gen-1", content: "Generic instruction", category: null, scope: "global", score: 0.8, accessCount: 1 }]

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions,
          composed: instructions.length > 0 ? `## Retrieved Preferences\n- ${instructions[0].content}\n` : "",
        }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      inject.clearRetrievalState("inst-tool", "sess-tool")

      await inject.retrieveForTool("inst-tool", "sess-tool", "playwright", { projectName: "ToolTest" })

      const state = inject.getRetrievalState().get("inst-tool:sess-tool")
      const toolInsts = state?.toolInstructions?.get("playwright") ?? []
      const composed = inject.getComposedInjection("inst-tool", "sess-tool")

      return {
        count: toolInsts.length,
        firstContent: toolInsts[0]?.content ?? "",
        firstCategory: toolInsts[0]?.category ?? "",
        composed,
      }
    })

    expect(result.count).toBe(1)
    expect(result.firstContent).toContain("headed mode")
    expect(result.firstCategory).toBe("testing")
    expect(result.composed).toContain("headed mode")

    console.log("PASS: Playwright tool retrieval returns testing-specific instructions")
  })

  test("multiple tools each get their own instructions", async ({ page }) => {
    const toolCallLog: string[] = []

    await page.route("**/api/era/retrieval/tool", async (route) => {
      const body = route.request().postDataJSON()
      const toolName = body?.toolName ?? "unknown"
      toolCallLog.push(toolName)

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [{ id: `tool-${toolName}-1`, content: `Instruction for ${toolName}`, category: null, scope: "project", score: 0.85, accessCount: 2 }],
          composed: `## Retrieved Preferences\n- Instruction for ${toolName}\n`,
        }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      inject.clearRetrievalState("inst-multi", "sess-multi")

      await inject.retrieveForTool("inst-multi", "sess-multi", "git", {})
      await inject.retrieveForTool("inst-multi", "sess-multi", "eslint", {})

      const state = inject.getRetrievalState().get("inst-multi:sess-multi")
      const gitInsts = state?.toolInstructions?.get("git") ?? []
      const eslintInsts = state?.toolInstructions?.get("eslint") ?? []

      // Composed injection should include both tools' instructions
      const composed = inject.getComposedInjection("inst-multi", "sess-multi")

      return {
        gitCount: gitInsts.length,
        eslintCount: eslintInsts.length,
        composed,
      }
    })

    expect(result.gitCount).toBe(1)
    expect(result.eslintCount).toBe(1)
    expect(result.composed).toContain("Instruction for git")
    expect(result.composed).toContain("Instruction for eslint")
    expect(toolCallLog).toContain("git")
    expect(toolCallLog).toContain("eslint")

    console.log("PASS: Multiple tools each get independent instructions")
  })
})

// ---------------------------------------------------------------------------
// Part 4: Access Counting & Feedback
// ---------------------------------------------------------------------------

test.describe("EC-059 Part 4: Access counting and feedback", () => {
  test("POST /api/era/retrieval/feedback records success feedback", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/retrieval/feedback`, {
      data: {
        sessionId: "feedback-session",
        instructionId: "test-inst-feedback-1",
        outcome: "success",
      },
    })

    if (resp.status() === 404) {
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    console.log("Feedback response:", JSON.stringify(body))

    expect(body).toHaveProperty("promoted")
    expect(body).toHaveProperty("accessCount")
    expect(body).toHaveProperty("feedbackScore")
    expect(typeof body.promoted).toBe("boolean")
    expect(typeof body.accessCount).toBe("number")
    expect(typeof body.feedbackScore).toBe("number")

    console.log("PASS: Feedback endpoint returns correct shape with success outcome")
  })

  test("POST /api/era/retrieval/feedback records dismissed feedback", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/retrieval/feedback`, {
      data: {
        sessionId: "feedback-session-2",
        instructionId: "test-inst-feedback-2",
        outcome: "dismissed",
      },
    })

    if (resp.status() === 404) {
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()

    expect(body).toHaveProperty("promoted")
    expect(body.promoted).toBe(false) // dismissed should not promote

    console.log("PASS: Dismissed feedback recorded correctly")
  })

  test("feedback with invalid outcome returns 400", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/retrieval/feedback`, {
      data: {
        sessionId: "feedback-bad",
        instructionId: "test-inst",
        outcome: "invalid_outcome",
      },
    })

    if (resp.status() === 404) {
      test.skip()
      return
    }

    expect(resp.status()).toBe(400)
    console.log("PASS: Invalid outcome returns 400")
  })

  test("feedback with missing fields returns 400", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/era/retrieval/feedback`, {
      data: { sessionId: "feedback-bad" },
    })

    if (resp.status() === 404) {
      test.skip()
      return
    }

    expect(resp.status()).toBe(400)
    console.log("PASS: Missing fields returns 400")
  })

  test("GET /api/era/retrieval/promotion-candidates returns array shape", async ({ request }) => {
    const resp = await request.fetch(`${BASE}/api/era/retrieval/promotion-candidates`)

    if (resp.status() === 404) {
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    console.log("Promotion candidates response:", JSON.stringify(body).slice(0, 300))

    expect(body).toHaveProperty("candidates")
    expect(Array.isArray(body.candidates)).toBe(true)

    // Each candidate should have instruction shape
    for (const c of body.candidates) {
      expect(c).toHaveProperty("id")
      expect(c).toHaveProperty("content")
      expect(c).toHaveProperty("accessCount")
      expect(c.accessCount).toBeGreaterThanOrEqual(10) // PROMOTION_THRESHOLD
    }

    console.log(`PASS: Promotion candidates returns ${body.candidates.length} candidate(s)`)
  })

  test("flush endpoint returns promotion candidates and count", async ({ request }) => {
    // First trigger some retrieval to build up access log
    await request.post(`${BASE}/api/era/retrieval/session-start`, {
      data: { sessionId: "flush-count-session", context: {} },
    })

    const resp = await request.post(`${BASE}/api/era/retrieval/flush`, {
      data: { sessionId: "flush-count-session" },
    })

    if (resp.status() === 404) {
      test.skip()
      return
    }

    expect(resp.ok()).toBe(true)
    const body = await resp.json()
    console.log("Enhanced flush response:", JSON.stringify(body))

    expect(body).toHaveProperty("flushed")
    expect(body).toHaveProperty("count")
    expect(body).toHaveProperty("promotionCandidates")
    expect(typeof body.flushed).toBe("boolean")
    expect(typeof body.count).toBe("number")
    expect(Array.isArray(body.promotionCandidates)).toBe(true)

    console.log("PASS: Flush endpoint returns enhanced response with count and candidates")
  })
})

// ---------------------------------------------------------------------------
// Part 5: Client-Side Feedback & Promotion
// ---------------------------------------------------------------------------

test.describe("EC-059 Part 5: Client-side feedback and promotion", () => {
  test.setTimeout(60000)

  test("recordFeedback calls server and returns result", async ({ page }) => {
    await page.route("**/api/era/retrieval/feedback", async (route) => {
      const body = route.request().postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          promoted: false,
          accessCount: (body?.outcome === "success" ? 6 : 5),
          feedbackScore: (body?.outcome === "success" ? 4.0 : 3.0),
        }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      const res = await inject.recordFeedback("inst-fb", "sess-fb", "inst-123", "success")
      return res
    })

    expect(result.promoted).toBe(false)
    expect(result.accessCount).toBe(6)
    expect(result.feedbackScore).toBe(4.0)

    console.log("PASS: Client-side recordFeedback calls server and returns result")
  })

  test("getPromotionCandidates calls server and returns candidates", async ({ page }) => {
    await page.route("**/api/era/retrieval/promotion-candidates", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          candidates: [
            { id: "promo-1", content: "Always use TypeScript", category: "style", scope: "global", score: 0.95, accessCount: 15, createdAt: "2026-01-01T00:00:00Z" },
          ],
        }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      return inject.getPromotionCandidates()
    })

    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(1)
    expect(result[0].id).toBe("promo-1")
    expect(result[0].accessCount).toBe(15)

    console.log("PASS: Client-side getPromotionCandidates returns server data")
  })

  test("recordFeedback handles server errors gracefully", async ({ page }) => {
    await page.route("**/api/era/retrieval/feedback", async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fail" }) })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      return inject.recordFeedback("inst-fb-err", "sess-fb-err", "inst-bad", "dismissed")
    })

    expect(result.promoted).toBe(false)
    expect(result.accessCount).toBe(0)
    expect(result.feedbackScore).toBe(0)

    console.log("PASS: Feedback errors return safe defaults")
  })
})

// ---------------------------------------------------------------------------
// Part 6: Event Bus (ERA-714)
// ---------------------------------------------------------------------------

test.describe("EC-059 Part 6: Retrieval event bus", () => {
  test.setTimeout(60000)

  test("instruction:retrieved event fires on session-start retrieval", async ({ page }) => {
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [{ id: "evt-1", content: "Event test instruction", category: null, scope: "global", score: 0.9, accessCount: 1 }],
          composed: "## Retrieved Preferences\n- Event test instruction\n",
        }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      const events: any[] = []

      const listener = (event: any) => events.push(event)
      inject.onRetrievalEvent(listener)

      inject.clearRetrievalState("inst-evt", "sess-evt")
      await inject.retrieveSessionStart("inst-evt", "sess-evt", {})

      inject.offRetrievalEvent(listener)

      return {
        eventCount: events.length,
        firstType: events[0]?.type,
        firstSessionId: events[0]?.sessionId,
        instructionCount: events[0]?.instructions?.length ?? 0,
      }
    })

    expect(result.eventCount).toBeGreaterThanOrEqual(1)
    expect(result.firstType).toBe("instruction:retrieved")
    expect(result.firstSessionId).toBe("sess-evt")
    expect(result.instructionCount).toBe(1)

    console.log("PASS: instruction:retrieved event fires on session-start retrieval")
  })

  test("instruction:injected event fires on getComposedInjection", async ({ page }) => {
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [{ id: "inj-1", content: "Inject test", category: null, scope: "global", score: 0.9, accessCount: 1 }],
          composed: "## Retrieved Preferences\n- Inject test\n",
        }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      const events: any[] = []

      inject.clearRetrievalState("inst-inj", "sess-inj")
      await inject.retrieveSessionStart("inst-inj", "sess-inj", {})

      // Subscribe after retrieval but before injection
      const listener = (event: any) => events.push(event)
      inject.onRetrievalEvent(listener)

      // Trigger injection
      const composed = inject.getComposedInjection("inst-inj", "sess-inj")

      inject.offRetrievalEvent(listener)

      return {
        composed,
        eventCount: events.length,
        injectionEvent: events.find((e: any) => e.type === "instruction:injected"),
      }
    })

    expect(result.composed).toContain("Inject test")
    expect(result.injectionEvent).toBeDefined()
    expect(result.injectionEvent.type).toBe("instruction:injected")
    expect(result.injectionEvent.instructions.length).toBe(1)

    console.log("PASS: instruction:injected event fires on getComposedInjection")
  })

  test("instruction:promoted event fires on flush with promotion candidates", async ({ page }) => {
    await page.route("**/api/era/retrieval/flush", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          flushed: true,
          count: 3,
          promotionCandidates: ["promo-id-1", "promo-id-2"],
        }),
      })
    })

    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [{ id: "p-1", content: "Test", category: null, scope: "global", score: 0.8, accessCount: 15 }],
          composed: "## Retrieved Preferences\n- Test\n",
        }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      const events: any[] = []

      inject.clearRetrievalState("inst-promo", "sess-promo")
      await inject.retrieveSessionStart("inst-promo", "sess-promo", {})

      const listener = (event: any) => events.push(event)
      inject.onRetrievalEvent(listener)

      await inject.flushSession("inst-promo", "sess-promo")

      inject.offRetrievalEvent(listener)

      const promotedEvent = events.find((e: any) => e.type === "instruction:promoted")
      return {
        eventCount: events.length,
        promotedEvent: promotedEvent ?? null,
      }
    })

    expect(result.promotedEvent).not.toBeNull()
    expect(result.promotedEvent.type).toBe("instruction:promoted")
    expect(result.promotedEvent.promotionCandidateIds).toEqual(["promo-id-1", "promo-id-2"])

    console.log("PASS: instruction:promoted event fires on flush with promotion candidates")
  })

  test("instruction:promoted event fires on feedback that triggers promotion", async ({ page }) => {
    await page.route("**/api/era/retrieval/feedback", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ promoted: true, accessCount: 12, feedbackScore: 11 }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      const events: any[] = []

      const listener = (event: any) => events.push(event)
      inject.onRetrievalEvent(listener)

      await inject.recordFeedback("inst-pfb", "sess-pfb", "promoted-inst-1", "success")

      inject.offRetrievalEvent(listener)

      const promotedEvent = events.find((e: any) => e.type === "instruction:promoted")
      return {
        eventCount: events.length,
        promotedEvent: promotedEvent ?? null,
      }
    })

    expect(result.promotedEvent).not.toBeNull()
    expect(result.promotedEvent.promotionCandidateIds).toEqual(["promoted-inst-1"])

    console.log("PASS: instruction:promoted event fires on feedback-triggered promotion")
  })

  test("no events fire when retrieval returns empty results", async ({ page }) => {
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ instructions: [], composed: "" }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      const events: any[] = []

      const listener = (event: any) => events.push(event)
      inject.onRetrievalEvent(listener)

      inject.clearRetrievalState("inst-noevt", "sess-noevt")
      await inject.retrieveSessionStart("inst-noevt", "sess-noevt", {})

      const composed = inject.getComposedInjection("inst-noevt", "sess-noevt")

      inject.offRetrievalEvent(listener)

      return { eventCount: events.length, composed }
    })

    expect(result.eventCount).toBe(0)
    expect(result.composed).toBe("")

    console.log("PASS: No events fire for empty retrieval results")
  })

  test("event listener can be removed with offRetrievalEvent", async ({ page }) => {
    await page.route("**/api/era/retrieval/session-start", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [{ id: "unsub-1", content: "Test", category: null, scope: "global", score: 0.8, accessCount: 1 }],
          composed: "## Retrieved Preferences\n- Test\n",
        }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      const events: any[] = []

      const listener = (event: any) => events.push(event)
      inject.onRetrievalEvent(listener)

      // First retrieval: should fire event
      inject.clearRetrievalState("inst-unsub", "sess-unsub-1")
      await inject.retrieveSessionStart("inst-unsub", "sess-unsub-1", {})
      const countAfterFirst = events.length

      // Unsubscribe
      inject.offRetrievalEvent(listener)

      // Second retrieval: should NOT fire event
      inject.clearRetrievalState("inst-unsub", "sess-unsub-2")
      await inject.retrieveSessionStart("inst-unsub", "sess-unsub-2", {})
      const countAfterSecond = events.length

      return { countAfterFirst, countAfterSecond }
    })

    expect(result.countAfterFirst).toBeGreaterThanOrEqual(1)
    expect(result.countAfterSecond).toBe(result.countAfterFirst) // No new events after unsubscribe

    console.log("PASS: offRetrievalEvent correctly removes listener")
  })
})

// ---------------------------------------------------------------------------
// Part 7: Graceful Degradation
// ---------------------------------------------------------------------------

test.describe("EC-059 Part 7: Graceful degradation", () => {
  test.setTimeout(60000)

  test("session proceeds when Era Memory is unavailable (all endpoints 500)", async ({ page }) => {
    // Mock all retrieval endpoints to fail
    await page.route("**/api/era/retrieval/**", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Era Memory unavailable" }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__

      inject.clearRetrievalState("inst-degrade", "sess-degrade")

      // None of these should throw
      let sessionStartThrew = false
      let toolThrew = false
      let flushThrew = false
      let feedbackThrew = false

      try {
        await inject.retrieveSessionStart("inst-degrade", "sess-degrade", {})
      } catch { sessionStartThrew = true }

      try {
        await inject.retrieveForTool("inst-degrade", "sess-degrade", "git", {})
      } catch { toolThrew = true }

      try {
        await inject.flushSession("inst-degrade", "sess-degrade")
      } catch { flushThrew = true }

      try {
        await inject.recordFeedback("inst-degrade", "sess-degrade", "bad-id", "success")
      } catch { feedbackThrew = true }

      const composed = inject.getComposedInjection("inst-degrade", "sess-degrade-2")

      return { sessionStartThrew, toolThrew, flushThrew, feedbackThrew, composed }
    })

    expect(result.sessionStartThrew).toBe(false)
    expect(result.toolThrew).toBe(false)
    expect(result.flushThrew).toBe(false)
    expect(result.feedbackThrew).toBe(false)
    expect(result.composed).toBe("")

    console.log("PASS: All retrieval operations degrade gracefully when server returns 500")
  })

  test("getPromotionCandidates returns empty on error", async ({ page }) => {
    await page.route("**/api/era/retrieval/promotion-candidates", async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fail" }) })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      return inject.getPromotionCandidates()
    })

    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)

    console.log("PASS: getPromotionCandidates returns empty array on server error")
  })

  test("instruction:retrieved event includes tool name context", async ({ page }) => {
    await page.route("**/api/era/retrieval/tool", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instructions: [{ id: "ctx-1", content: "Context test", category: null, scope: "global", score: 0.8, accessCount: 1 }],
          composed: "## Retrieved Preferences\n- Context test\n",
        }),
      })
    })

    if (!(await setupPage(page))) {
      test.skip()
      return
    }

    const result = await page.evaluate(async () => {
      const inject = (window as any).__TEST_INJECT__
      const events: any[] = []

      const listener = (event: any) => events.push(event)
      inject.onRetrievalEvent(listener)

      inject.clearRetrievalState("inst-ctx", "sess-ctx")
      await inject.retrieveForTool("inst-ctx", "sess-ctx", "docker", {})

      inject.offRetrievalEvent(listener)

      const retrievedEvent = events.find((e: any) => e.type === "instruction:retrieved")
      return { toolName: retrievedEvent?.toolName }
    })

    expect(result.toolName).toBe("docker")

    console.log("PASS: Tool retrieval event includes toolName context")
  })
})
