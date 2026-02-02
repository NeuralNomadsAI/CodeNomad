import { test, expect } from "@playwright/test"

test.describe("EC-061: Phase 8 — Advanced Agent UI", () => {
  test.setTimeout(60000)

  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:3000")
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)
  })

  // ============================================================================
  // Part 1: Server Endpoint Tests
  // ============================================================================

  test.describe("Part 1 — Server Endpoints", () => {
    test("agents queue endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/agents/queue")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("agents")
      expect(Array.isArray(response.data.agents)).toBe(true)
    })

    test("agents lifecycle endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/agents/lifecycle")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("agents")
      expect(Array.isArray(response.data.agents)).toBe(true)
    })

    test("swarm messages endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/swarm/messages")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("messages")
      expect(Array.isArray(response.data.messages)).toBe(true)
    })

    test("gates status endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/gates/status")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("gates")
      expect(Array.isArray(response.data.gates)).toBe(true)
    })

    test("handoffs endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/handoffs")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("handoffs")
      expect(response.data).toHaveProperty("chain")
      expect(Array.isArray(response.data.handoffs)).toBe(true)
      expect(Array.isArray(response.data.chain)).toBe(true)
    })

    test("gates endpoint accepts planId query parameter", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/gates/status?planId=test-plan")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("gates")
    })

    test("handoffs endpoint accepts sessionId query parameter", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/handoffs?sessionId=test-session")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("handoffs")
    })
  })

  // ============================================================================
  // Part 2: Component Import Tests
  // ============================================================================

  test.describe("Part 2 — Component Infrastructure", () => {
    test("agent-queue-panel component exports default", async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const mod = await import("/src/components/agent-queue-panel.tsx")
          return { hasDefault: typeof mod.default === "function" }
        } catch {
          return { hasDefault: false }
        }
      })

      expect(result.hasDefault).toBe(true)
    })

    test("swarm-communication-log component exports default", async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const mod = await import("/src/components/swarm-communication-log.tsx")
          return { hasDefault: typeof mod.default === "function" }
        } catch {
          return { hasDefault: false }
        }
      })

      expect(result.hasDefault).toBe(true)
    })

    test("session-retry-panel component exports default", async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const mod = await import("/src/components/session-retry-panel.tsx")
          return { hasDefault: typeof mod.default === "function" }
        } catch {
          return { hasDefault: false }
        }
      })

      expect(result.hasDefault).toBe(true)
    })

    test("governance-toast component exports default and helpers", async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const mod = await import("/src/components/governance-toast.tsx")
          return {
            hasDefault: typeof mod.default === "function",
            hasPush: typeof mod.pushNotification === "function",
            hasDismiss: typeof mod.dismissNotification === "function",
            hasClear: typeof mod.clearNotifications === "function",
          }
        } catch {
          return { hasDefault: false, hasPush: false, hasDismiss: false, hasClear: false }
        }
      })

      expect(result.hasDefault).toBe(true)
      expect(result.hasPush).toBe(true)
      expect(result.hasDismiss).toBe(true)
      expect(result.hasClear).toBe(true)
    })

    test("agent-lifecycle-panel component exports default", async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const mod = await import("/src/components/agent-lifecycle-panel.tsx")
          return { hasDefault: typeof mod.default === "function" }
        } catch {
          return { hasDefault: false }
        }
      })

      expect(result.hasDefault).toBe(true)
    })

    test("gate-status-panel component exports default", async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const mod = await import("/src/components/gate-status-panel.tsx")
          return { hasDefault: typeof mod.default === "function" }
        } catch {
          return { hasDefault: false }
        }
      })

      expect(result.hasDefault).toBe(true)
    })

    test("handoff-visualization component exports default", async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const mod = await import("/src/components/handoff-visualization.tsx")
          return { hasDefault: typeof mod.default === "function" }
        } catch {
          return { hasDefault: false }
        }
      })

      expect(result.hasDefault).toBe(true)
    })
  })

  // ============================================================================
  // Part 3: Graceful Degradation
  // ============================================================================

  test.describe("Part 3 — Graceful Degradation", () => {
    test("all Phase 8 endpoints return graceful defaults", async ({ page }) => {
      const endpoints = [
        "/api/era/agents/queue",
        "/api/era/agents/lifecycle",
        "/api/era/swarm/messages",
        "/api/era/gates/status",
        "/api/era/handoffs",
      ]

      for (const endpoint of endpoints) {
        const response = await page.evaluate(async (url) => {
          const res = await fetch(url)
          return { status: res.status, data: await res.json() }
        }, endpoint)

        expect(response.status).toBe(200)
        // All should return empty arrays, not errors
        const values = Object.values(response.data)
        for (const val of values) {
          if (Array.isArray(val)) {
            expect(val.length).toBe(0)
          }
        }
      }
    })

    test("Phase 7 endpoints still work after Phase 8 routes added", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const [formulas, plans] = await Promise.all([
          fetch("/api/era/formulas").then((r) => r.json()),
          fetch("/api/era/plans/status?planId=test").then((r) => r.json()),
        ])
        return { formulas, plans }
      })

      expect(response.formulas).toHaveProperty("formulas")
      expect(response.plans).toHaveProperty("plan")
    })

    test("Phase 5 endpoints still work after Phase 8 routes added", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const [health, verification] = await Promise.all([
          fetch("/api/era/health").then((r) => r.json()),
          fetch("/api/era/verification/status").then((r) => r.json()),
        ])
        return { health, verification }
      })

      expect(response.health).toHaveProperty("checks")
      expect(response.verification).toHaveProperty("phases")
    })
  })
})
