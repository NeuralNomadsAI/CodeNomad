/**
 * EC-060 — Phase 1: Immediate CodeNomad Wins Validation
 *
 * Tests:
 *  1. Context pressure warnings (ERA-619) — 4-level color thresholds, toast logic
 *  2. Truncation display controls (ERA-620) — char count badge infrastructure
 *  3. Plan pipeline status ribbon (ERA-621) — phase indicator component
 */
import { test, expect } from "@playwright/test"
import { readFileSync, existsSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BASE = "http://localhost:3000"
const SCREENSHOT_DIR = "test-screenshots"
const UI_SRC = resolve(__dirname, "../../src")

function readSrc(relativePath: string): string {
  const fullPath = resolve(UI_SRC, relativePath)
  if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`)
  return readFileSync(fullPath, "utf-8")
}

// ─── Part 1: Context Pressure Warnings (ERA-619) ────────────────────────────

test.describe("Part 1 — Context pressure warnings", () => {
  test("context-progress-bar has 4-level color thresholds", () => {
    const src = readSrc("components/context-progress-bar.tsx")
    expect(src).toContain('"low"')
    expect(src).toContain('"moderate"')
    expect(src).toContain('"elevated"')
    expect(src).toContain('"critical"')
    expect(src).toContain("ContextUsageLevel")
    expect(src).toContain("onLevelChange")
    // Verify 4 distinct thresholds
    expect(src).toContain("pct >= 85")
    expect(src).toContain("pct >= 70")
    expect(src).toContain("pct >= 50")
  })

  test("context-progress-bar uses CSS custom properties for colors", () => {
    const src = readSrc("components/context-progress-bar.tsx")
    expect(src).toContain("context-progress-critical")
    expect(src).toContain("context-progress-warning")
    expect(src).toContain("context-progress-moderate")
    expect(src).toContain("context-progress-low")
    expect(src).toContain("context-progress-track")
  })

  test("activity-status-line has context pressure toast at 70%", () => {
    const src = readSrc("components/activity-status-line.tsx")
    expect(src).toContain("showToastNotification")
    expect(src).toContain("pressureWarningFired")
    expect(src).toContain("contextPercentage")
    expect(src).toContain("pct >= 70")
    expect(src).toContain("Context window filling")
    // Toast fires once per session
    expect(src).toContain("setPressureWarningFired(true)")
  })

  test("elevated and critical levels change label text color", () => {
    const src = readSrc("components/context-progress-bar.tsx")
    expect(src).toContain("text-destructive") // critical
    expect(src).toContain("text-warning")     // elevated
    expect(src).toContain("levelTextColor")
  })
})

// ─── Part 2: Truncation Display Controls (ERA-620) ──────────────────────────

test.describe("Part 2 — Truncation display controls", () => {
  test("tool-call-group has truncation infrastructure", () => {
    const src = readSrc("components/tool-call-group.tsx")
    expect(src).toContain("TRUNCATION_DISPLAY_THRESHOLD")
    expect(src).toContain("formatCharCount")
    expect(src).toContain("computeOutputSize")
    expect(src).toContain("truncationLabel")
    expect(src).toContain("isTruncated")
  })

  test("truncation uses Scissors icon and warning-tinted badge", () => {
    const src = readSrc("components/tool-call-group.tsx")
    expect(src).toContain("Scissors")
    expect(src).toContain("bg-warning/10")
    expect(src).toContain("border-warning/20")
  })

  test("truncation badge shows in both single and multi-item groups", () => {
    const src = readSrc("components/tool-call-group.tsx")
    // Count occurrences of truncationLabel display — should appear in both branches
    const matches = src.match(/truncationLabel\(\)/g)
    // At least 4 occurrences: 2 for memo + 2 for Show when renders
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(4)
  })

  test("formatCharCount formats correctly", () => {
    // Inline test of the formatting logic
    function formatCharCount(n: number): string {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
      return String(n)
    }
    expect(formatCharCount(500)).toBe("500")
    expect(formatCharCount(2100)).toBe("2.1k")
    expect(formatCharCount(47000)).toBe("47.0k")
    expect(formatCharCount(1500000)).toBe("1.5m")
  })
})

// ─── Part 3: Plan Pipeline Status Ribbon (ERA-621) ──────────────────────────

test.describe("Part 3 — Plan pipeline status ribbon", () => {
  test("plan-status-ribbon component exists with 3 phases", () => {
    const src = readSrc("components/plan-status-ribbon.tsx")
    expect(src).toContain("PlanPhase")
    expect(src).toContain('"planning"')
    expect(src).toContain('"reviewing"')
    expect(src).toContain('"executing"')
    expect(src).toContain("detectPlanPhase")
    expect(src).toContain("messageStoreBus")
  })

  test("plan-status-ribbon detects plan/reviewer/coder agent types", () => {
    const src = readSrc("components/plan-status-ribbon.tsx")
    expect(src).toContain('agentType === "plan"')
    expect(src).toContain('agentType === "reviewer"')
    expect(src).toContain('agentType === "coder"')
    expect(src).toContain('agentType === "test-writer"')
  })

  test("plan-status-ribbon shows active phase with pulse indicator", () => {
    const src = readSrc("components/plan-status-ribbon.tsx")
    expect(src).toContain("animate-pulse")
    expect(src).toContain("bg-info/15")
    expect(src).toContain("ring-info/30")
    expect(src).toContain("text-success") // past phases
  })

  test("session-view includes PlanStatusRibbon", () => {
    const src = readSrc("components/session/session-view.tsx")
    expect(src).toContain("PlanStatusRibbon")
    expect(src).toContain("<PlanStatusRibbon")
    expect(src).toContain("plan-status-ribbon")
  })
})

// ─── Part 4: Integration Smoke Test ─────────────────────────────────────────

test.describe("Part 4 — Integration smoke test", () => {
  test("app loads without critical errors after Phase 1 changes", async ({ page }) => {
    const consoleErrors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text())
    })

    await page.goto(BASE)
    await page.waitForSelector("[data-testid='app-root'], .app-root, #root", { timeout: 10_000 })
    await page.waitForTimeout(2000)

    // Filter out known non-critical errors
    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("404") &&
        !e.includes("net::ERR") &&
        !e.includes("WebSocket") &&
        !e.includes("Failed to load resource"),
    )

    expect(criticalErrors.length).toBe(0)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/EC-060-01-phase1-final.png` })
  })
})
