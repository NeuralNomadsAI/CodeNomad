import { test, expect } from "@playwright/test"

test.describe("EC-060: Phase 7 — Workflow Formulas & Plan Execution", () => {
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
    test("formulas endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/formulas")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("formulas")
      expect(Array.isArray(response.data.formulas)).toBe(true)
    })

    test("formulas endpoint returns formulas with correct structure", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/formulas")
        return await res.json()
      })

      expect(response.formulas.length).toBeGreaterThan(0)
      const formula = response.formulas[0]
      expect(formula).toHaveProperty("name")
      expect(formula).toHaveProperty("description")
      expect(formula).toHaveProperty("source")
      expect(formula).toHaveProperty("variables")
      expect(formula).toHaveProperty("steps")
      expect(Array.isArray(formula.variables)).toBe(true)
      expect(Array.isArray(formula.steps)).toBe(true)
    })

    test("formulas have valid step structure with dependencies", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/formulas")
        return await res.json()
      })

      const formula = response.formulas[0]
      for (const step of formula.steps) {
        expect(step).toHaveProperty("id")
        expect(step).toHaveProperty("name")
        expect(step).toHaveProperty("action")
      }

      // At least one step should have dependencies
      const withDeps = formula.steps.filter((s: { dependsOn?: string[] }) => s.dependsOn && s.dependsOn.length > 0)
      expect(withDeps.length).toBeGreaterThan(0)
    })

    test("plan status endpoint returns valid shape", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/plans/status?planId=test-plan")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("plan")
    })

    test("plan status returns plan with steps when planId provided", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/plans/status?planId=test-plan")
        return await res.json()
      })

      expect(response.plan).not.toBeNull()
      expect(response.plan).toHaveProperty("id")
      expect(response.plan).toHaveProperty("formulaName")
      expect(response.plan).toHaveProperty("status")
      expect(response.plan).toHaveProperty("steps")
      expect(Array.isArray(response.plan.steps)).toBe(true)
      expect(response.plan.steps.length).toBeGreaterThan(0)
    })

    test("plan status returns null plan without planId", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/plans/status")
        return await res.json()
      })

      expect(response.plan).toBeNull()
    })

    test("plan steps have correct status fields", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/plans/status?planId=test-plan")
        return await res.json()
      })

      for (const step of response.plan.steps) {
        expect(step).toHaveProperty("id")
        expect(step).toHaveProperty("stepId")
        expect(step).toHaveProperty("name")
        expect(step).toHaveProperty("status")
        expect(["pending", "running", "completed", "failed", "skipped", "rolled-back"]).toContain(step.status)
      }
    })

    test("formulas include gate steps", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/formulas")
        return await res.json()
      })

      // deploy-service formula should have a gate step
      const deployFormula = response.formulas.find((f: { name: string }) => f.name === "deploy-service")
      expect(deployFormula).toBeDefined()
      const gateStep = deployFormula.steps.find((s: { gate?: string }) => s.gate)
      expect(gateStep).toBeDefined()
      expect(gateStep.gate).toBe("human")
    })
  })

  // ============================================================================
  // Part 2: Component Import Tests
  // ============================================================================

  test.describe("Part 2 — Component Infrastructure", () => {
    test("formula-browser component file exists and exports default", async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const mod = await import("/src/components/formula-browser.tsx")
          return { hasDefault: typeof mod.default === "function" }
        } catch {
          return { hasDefault: false }
        }
      })

      expect(result.hasDefault).toBe(true)
    })

    test("plan-execution-tracker component file exists and exports default", async ({ page }) => {
      const result = await page.evaluate(async () => {
        try {
          const mod = await import("/src/components/plan-execution-tracker.tsx")
          return { hasDefault: typeof mod.default === "function" }
        } catch {
          return { hasDefault: false }
        }
      })

      expect(result.hasDefault).toBe(true)
    })
  })

  // ============================================================================
  // Part 3: Formula Data Tests
  // ============================================================================

  test.describe("Part 3 — Formula Data Integrity", () => {
    test("formulas have unique names", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/formulas")
        return await res.json()
      })

      const names = response.formulas.map((f: { name: string }) => f.name)
      const unique = new Set(names)
      expect(unique.size).toBe(names.length)
    })

    test("formula variables have types", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/formulas")
        return await res.json()
      })

      for (const formula of response.formulas) {
        for (const variable of formula.variables) {
          expect(variable).toHaveProperty("name")
          expect(variable).toHaveProperty("type")
          expect(["string", "number", "boolean", "list", "path"]).toContain(variable.type)
        }
      }
    })

    test("formula step dependencies reference valid step IDs", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/formulas")
        return await res.json()
      })

      for (const formula of response.formulas) {
        const stepIds = new Set(formula.steps.map((s: { id: string }) => s.id))
        for (const step of formula.steps) {
          if (step.dependsOn) {
            for (const dep of step.dependsOn) {
              expect(stepIds.has(dep)).toBe(true)
            }
          }
        }
      }
    })

    test("multiple formula sources represented", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/formulas")
        return await res.json()
      })

      const sources = new Set(response.formulas.map((f: { source: string }) => f.source))
      expect(sources.size).toBeGreaterThanOrEqual(2)
    })
  })

  // ============================================================================
  // Part 4: Graceful Degradation
  // ============================================================================

  test.describe("Part 4 — Graceful Degradation", () => {
    test("formulas endpoint handles errors gracefully", async ({ page }) => {
      // Even if something goes wrong internally, the endpoint should still return
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/formulas?folder=/nonexistent/path")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("formulas")
    })

    test("plan status handles missing plan gracefully", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/plans/status?planId=nonexistent-plan")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data).toHaveProperty("plan")
    })

    test("plan status handles empty query gracefully", async ({ page }) => {
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/era/plans/status")
        return { status: res.status, data: await res.json() }
      })

      expect(response.status).toBe(200)
      expect(response.data.plan).toBeNull()
    })
  })
})
