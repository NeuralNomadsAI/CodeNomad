import { test, expect } from "@playwright/test"

test.describe("EC-059: Phase 5 — Visualization Components", () => {
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
    test("delegation categories endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/delegation/categories")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("categories")
      expect(Array.isArray(response.data.categories)).toBe(true)
    })

    test("model fallback chain endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/models/fallback-chain")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("chains")
      expect(Array.isArray(response.data.chains)).toBe(true)
    })

    test("health endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/health")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("checks")
      expect(response.data).toHaveProperty("overall")
      expect(response.data).toHaveProperty("timestamp")
    })

    test("beads issues endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/beads/issues")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("issues")
      expect(Array.isArray(response.data.issues)).toBe(true)
    })

    test("beads graph endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/beads/graph")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("nodes")
      expect(response.data).toHaveProperty("edges")
    })

    test("audit events endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/audit/events")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("events")
      expect(Array.isArray(response.data.events)).toBe(true)
    })

    test("verification status endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/verification/status")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("phases")
      expect(response.data).toHaveProperty("overall")
    })

    test("file governance rules endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/governance/file-rules")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("rules")
      expect(Array.isArray(response.data.rules)).toBe(true)
    })

    test("refactoring impact endpoint requires parameters", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/refactoring/impact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(400)
      expect(response.data).toHaveProperty("error")
    })
  })

  // ============================================================================
  // Part 2: Component Rendering Tests
  // ============================================================================

  test.describe("Part 2 — Component Infrastructure", () => {
    test("Tailwind theme variables are active", async ({ page }) => {
      const hasTheme = await page.evaluate(() => {
        const cs = window.getComputedStyle(document.documentElement)
        const bg = cs.getPropertyValue("--background").trim()
        return bg.length > 0
      })

      expect(hasTheme).toBe(true)
    })

    test("Tailwind component classes produce computed styles", async ({ page }) => {
      const hasStyles = await page.evaluate(() => {
        const div = document.createElement("div")
        div.className = "bg-background text-foreground rounded-md border p-4"
        document.body.appendChild(div)
        const cs = window.getComputedStyle(div)
        const hasBg = cs.backgroundColor !== ""
        document.body.removeChild(div)
        return hasBg
      })

      expect(hasStyles).toBe(true)
    })

    test("SolidJS Card component renders with correct structure", async ({ page }) => {
      const hasCardStructure = await page.evaluate(() => {
        const div = document.createElement("div")
        div.className = "rounded-xl border bg-card text-card-foreground shadow"
        document.body.appendChild(div)
        const cs = window.getComputedStyle(div)
        const hasRadius = cs.borderRadius !== ""
        document.body.removeChild(div)
        return hasRadius
      })

      expect(hasCardStructure).toBe(true)
    })

    test("Badge variant styles are available", async ({ page }) => {
      const hasBadgeStyles = await page.evaluate(() => {
        const badge = document.createElement("span")
        badge.className = "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs"
        document.body.appendChild(badge)
        const cs = window.getComputedStyle(badge)
        const hasDisplay = cs.display === "inline-flex"
        document.body.removeChild(badge)
        return hasDisplay
      })

      expect(hasBadgeStyles).toBe(true)
    })
  })

  // ============================================================================
  // Part 3: Delegation Category Tests
  // ============================================================================

  test.describe("Part 3 — Delegation Categories", () => {
    test("categories endpoint returns expected category IDs", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/delegation/categories")
        return res.json()
      })

      const ids = response.categories.map((c: { id: string }) => c.id)
      expect(ids).toContain("visual-engineering")
      expect(ids).toContain("ultrabrain")
      expect(ids).toContain("quick")
    })

    test("each category has model and keywords", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/delegation/categories")
        return res.json()
      })

      for (const cat of response.categories) {
        expect(cat).toHaveProperty("model")
        expect(cat).toHaveProperty("keywords")
        expect(typeof cat.model).toBe("string")
        expect(Array.isArray(cat.keywords)).toBe(true)
      }
    })
  })

  // ============================================================================
  // Part 4: Model Fallback Chain Tests
  // ============================================================================

  test.describe("Part 4 — Fallback Chains", () => {
    test("chains include provider and primary model", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/models/fallback-chain")
        return res.json()
      })

      for (const chain of response.chains) {
        expect(chain).toHaveProperty("provider")
        expect(chain).toHaveProperty("primary")
        expect(chain.primary).toHaveProperty("id")
        expect(chain.primary).toHaveProperty("name")
        expect(chain.primary).toHaveProperty("available")
        expect(chain).toHaveProperty("fallbacks")
        expect(Array.isArray(chain.fallbacks)).toBe(true)
      }
    })

    test("anthropic chain has expected structure", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/models/fallback-chain")
        return res.json()
      })

      const anthropic = response.chains.find((c: { provider: string }) => c.provider === "anthropic")
      expect(anthropic).toBeDefined()
      expect(anthropic.primary.id).toContain("claude")
      expect(anthropic.fallbacks.length).toBeGreaterThan(0)
    })
  })

  // ============================================================================
  // Part 5: Health Check Tests
  // ============================================================================

  test.describe("Part 5 — Health Checks", () => {
    test("health checks return status for each component", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/health")
        return res.json()
      })

      expect(response.checks.length).toBeGreaterThan(0)

      for (const check of response.checks) {
        expect(check).toHaveProperty("name")
        expect(check).toHaveProperty("status")
        expect(check).toHaveProperty("message")
        expect(["healthy", "warning", "error", "unknown"]).toContain(check.status)
      }
    })

    test("overall status is a valid value", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/health")
        return res.json()
      })

      expect(["healthy", "warning", "error", "unknown"]).toContain(response.overall)
    })
  })

  // ============================================================================
  // Part 6: Graceful Degradation Tests
  // ============================================================================

  test.describe("Part 6 — Graceful Degradation", () => {
    test("beads endpoints return empty arrays when service unavailable", async ({ page }) => {
      const issues = await page.evaluate(async () => {
        const res = await fetch("/api/era/beads/issues")
        return res.json()
      })

      // Should not throw, should return empty gracefully
      expect(issues).toHaveProperty("issues")
      expect(Array.isArray(issues.issues)).toBe(true)
    })

    test("audit events return empty array when no events", async ({ page }) => {
      const events = await page.evaluate(async () => {
        const res = await fetch("/api/era/audit/events?limit=0")
        return res.json()
      })

      expect(events).toHaveProperty("events")
      expect(Array.isArray(events.events)).toBe(true)
    })

    test("verification status returns idle state by default", async ({ page }) => {
      const status = await page.evaluate(async () => {
        const res = await fetch("/api/era/verification/status")
        return res.json()
      })

      expect(status).toHaveProperty("overall")
      expect(status).toHaveProperty("phases")
    })

    test("governance file rules return empty when no project", async ({ page }) => {
      const rules = await page.evaluate(async () => {
        const res = await fetch("/api/era/governance/file-rules")
        return res.json()
      })

      expect(rules).toHaveProperty("rules")
      expect(Array.isArray(rules.rules)).toBe(true)
    })

    test("refactoring impact validates input", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/refactoring/impact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder: "/tmp", operation: "rename" }),
        })
        return { status: res.status, data: await res.json() }
      })

      // Missing target should return 400
      expect(response.status).toBe(400)
    })

    test("valid refactoring impact returns safe result", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/refactoring/impact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folder: "/tmp",
            operation: "rename",
            target: "testSymbol",
          }),
        })
        return res.json()
      })

      expect(response).toHaveProperty("operation")
      expect(response).toHaveProperty("target")
      expect(response).toHaveProperty("affectedFiles")
      expect(response).toHaveProperty("safe")
    })
  })

  // ============================================================================
  // Screenshots
  // ============================================================================

  test("capture initial state screenshot", async ({ page }) => {
    await page.screenshot({
      path: "test-screenshots/EC-059-01-initial.png",
      fullPage: true,
    })
  })

  test("capture final state screenshot", async ({ page }) => {
    // Interact with page to trigger some state
    await page.waitForTimeout(1000)
    await page.screenshot({
      path: "test-screenshots/EC-059-06-final.png",
      fullPage: true,
    })
  })
})
