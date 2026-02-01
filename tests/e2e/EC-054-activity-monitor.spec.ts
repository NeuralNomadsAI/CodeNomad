import { test, expect } from "@playwright/test"

const APP_URL = "http://localhost:3000"
const API_BASE = "http://localhost:9898"

/**
 * Helper: open Full Settings pane from anywhere in the app.
 *
 * On the welcome/folder-selection screen the flow is:
 *   "Advanced Settings" button → Advanced Settings modal → "All Settings" footer button → Full Settings pane
 *
 * Inside a workspace the flow is:
 *   bottom-bar Settings → Settings panel → "All Settings" / gear button → Full Settings pane
 */
async function openFullSettings(page: import("@playwright/test").Page) {
  // Already open?
  const navSidebar = page.locator(".full-settings-nav")
  if (await navSidebar.isVisible({ timeout: 500 }).catch(() => false)) {
    return
  }

  // Path 1: Welcome screen → "Advanced Settings" button → modal → "All Settings"
  const advancedSettingsBtn = page.locator("button").filter({ hasText: /Advanced Settings/i }).first()
  if (await advancedSettingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await advancedSettingsBtn.click()
    await page.waitForTimeout(800)

    // Inside the Advanced Settings modal, click "All Settings" in the footer
    const allSettingsFooterBtn = page.getByRole("button", { name: /All Settings/i }).first()
    if (await allSettingsFooterBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await allSettingsFooterBtn.click()
      await page.waitForTimeout(800)
      if (await navSidebar.isVisible({ timeout: 2000 }).catch(() => false)) {
        return
      }
    }
  }

  // Path 2: Bottom-bar "Settings" shortcut on welcome screen (also opens Advanced Settings modal)
  const settingsShortcutBtn = page.locator("button.home-shortcut-item").filter({ hasText: /Settings/i }).first()
  if (await settingsShortcutBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await settingsShortcutBtn.click()
    await page.waitForTimeout(800)

    const allSettingsFooterBtn = page.getByRole("button", { name: /All Settings/i }).first()
    if (await allSettingsFooterBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await allSettingsFooterBtn.click()
      await page.waitForTimeout(800)
      if (await navSidebar.isVisible({ timeout: 2000 }).catch(() => false)) {
        return
      }
    }
  }

  // Path 3: Workspace view – Settings button in toolbar
  const openSettingsButton = page.locator('button[title="Settings"]')
  if (await openSettingsButton.isVisible().catch(() => false)) {
    await openSettingsButton.click()
    await page.waitForTimeout(500)
  }

  // Open Full Settings overlay from quick-settings panel
  const allSettingsBtn = page.getByRole("button", { name: /All Settings/i }).first()
  if (await allSettingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await allSettingsBtn.click()
    await page.waitForTimeout(500)
  }
}

test.describe("EC-054: Activity Monitor", () => {
  test.setTimeout(120000)

  // ------------------------------------------------------------------
  // 1. Navigation: old items removed, Activity Monitor appears
  // ------------------------------------------------------------------
  test("should show Activity Monitor in settings nav and NOT show old items", async ({ page }) => {
    await page.goto(APP_URL)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    await openFullSettings(page)
    await page.screenshot({ path: "test-screenshots/EC-054-01-settings-nav.png", fullPage: true })

    // "Activity Monitor" nav button must exist
    const activityNav = page.getByRole("button", { name: /Activity Monitor/i })
    await expect(activityNav).toBeVisible({ timeout: 5000 })
    console.log("PASS: Activity Monitor nav item visible")

    // Old nav items must be gone
    const allSessionsNav = page.getByRole("button", { name: /^All Sessions$/i })
    await expect(allSessionsNav).not.toBeVisible({ timeout: 2000 }).catch(() => {
      // may not be present at all — that's fine
    })
    const oldSessionsCount = await allSessionsNav.count()
    expect(oldSessionsCount).toBe(0)
    console.log("PASS: 'All Sessions' nav item removed")

    // "Processes" as a standalone nav should not exist — but "Activity Monitor" contains
    // the word, so we look for an exact match.
    const processesNav = page.locator('button').filter({ hasText: /^Processes$/ })
    const processesCount = await processesNav.count()
    expect(processesCount).toBe(0)
    console.log("PASS: 'Processes' nav item removed")
  })

  // ------------------------------------------------------------------
  // 2. Panel loads with summary stats
  // ------------------------------------------------------------------
  test("should display summary stats with correct labels", async ({ page }) => {
    await page.goto(APP_URL)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    await openFullSettings(page)

    // Navigate to Activity Monitor
    const activityNav = page.getByRole("button", { name: /Activity Monitor/i })
    await activityNav.click()
    await page.waitForTimeout(500)

    // Wait for loading to finish
    const loadingSpinner = page.locator(".activity-monitor-loading")
    await expect(loadingSpinner).not.toBeVisible({ timeout: 15000 })

    await page.screenshot({ path: "test-screenshots/EC-054-02-activity-monitor-panel.png", fullPage: true })

    // Header
    const header = page.locator("h2").filter({ hasText: /Activity Monitor/i })
    await expect(header).toBeVisible({ timeout: 5000 })
    console.log("PASS: Activity Monitor header visible")

    // Summary stat cards
    const statCards = page.locator(".activity-monitor-stats .activity-monitor-stat")
    await expect(statCards.first()).toBeVisible({ timeout: 10000 })
    const cardCount = await statCards.count()
    expect(cardCount).toBe(4)
    console.log(`PASS: Found ${cardCount} summary stat cards`)

    // Stat labels
    const labels = page.locator(".activity-monitor-stat-label")
    const labelTexts: string[] = []
    for (let i = 0; i < await labels.count(); i++) {
      labelTexts.push((await labels.nth(i).textContent()) ?? "")
    }
    console.log("Stat labels:", labelTexts)
    expect(labelTexts).toEqual(
      expect.arrayContaining(["Instances", "Running", "Orphans", "Sessions"])
    )
    console.log("PASS: All four summary stat labels present")
  })

  // ------------------------------------------------------------------
  // 3. Active Instances section
  // ------------------------------------------------------------------
  test("should display active instances section", async ({ page }) => {
    await page.goto(APP_URL)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    await openFullSettings(page)

    const activityNav = page.getByRole("button", { name: /Activity Monitor/i })
    await activityNav.click()
    await page.waitForTimeout(500)

    // Wait for loading to finish
    await expect(page.locator(".activity-monitor-loading")).not.toBeVisible({ timeout: 15000 })

    // Section title (uses full-settings-subsection-title)
    const instancesTitle = page.locator(".full-settings-subsection-title").filter({ hasText: /Active Instances/i })
    await expect(instancesTitle).toBeVisible({ timeout: 10000 })
    console.log("PASS: Active Instances section visible")

    // Either we see list items or the empty state
    const items = page.locator(".full-settings-list-item")
    const emptyState = page.locator(".activity-monitor-empty-state").first()
    const itemCount = await items.count()
    const isEmpty = await emptyState.isVisible().catch(() => false)

    await page.screenshot({ path: "test-screenshots/EC-054-03-active-instances.png", fullPage: true })

    expect(itemCount > 0 || isEmpty).toBeTruthy()

    if (itemCount > 0) {
      // Verify first instance has PID badge
      const firstItem = items.first()
      const pidBadge = firstItem.locator(".activity-monitor-pid-badge")
      await expect(pidBadge).toBeVisible()
      const pid = await pidBadge.textContent()
      console.log(`PASS: First instance PID: ${pid}`)

      // Check for Kill button on running instances
      const killBtn = firstItem.locator(".activity-monitor-kill-btn")
      if (await killBtn.isVisible().catch(() => false)) {
        console.log("PASS: Kill button visible on instance")
      }
    } else {
      console.log("INFO: No registered instances (empty state shown)")
    }
  })

  // ------------------------------------------------------------------
  // 4. Session cleanup section
  // ------------------------------------------------------------------
  test("should display session cleanup section", async ({ page }) => {
    await page.goto(APP_URL)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    await openFullSettings(page)

    const activityNav = page.getByRole("button", { name: /Activity Monitor/i })
    await activityNav.click()
    await page.waitForTimeout(500)

    // Wait for loading to finish
    await expect(page.locator(".activity-monitor-loading")).not.toBeVisible({ timeout: 15000 })

    // Session cleanup section title
    const cleanupTitle = page.locator(".full-settings-subsection-title").filter({ hasText: /Session Cleanup/i })
    await expect(cleanupTitle).toBeVisible({ timeout: 10000 })
    console.log("PASS: Session Cleanup section visible")

    // Description should show session count and project count
    const desc = page.locator(".activity-monitor-section-desc").filter({ hasText: /sessions across/i })
    await expect(desc).toBeVisible({ timeout: 5000 })
    const descText = await desc.textContent()
    console.log(`PASS: Description text: "${descText}"`)

    await page.screenshot({ path: "test-screenshots/EC-054-04-session-cleanup.png", fullPage: true })

    // Either cleanup action rows (stale/blank) or the "All clean" message
    const cleanupActions = page.locator(".activity-monitor-cleanup-actions .full-settings-toggle-row")
    const allClean = page.locator(".activity-monitor-all-clean")
    const hasActions = (await cleanupActions.count()) > 0
    const isAllClean = await allClean.isVisible().catch(() => false)

    expect(hasActions || isAllClean).toBeTruthy()

    if (hasActions) {
      const actionCount = await cleanupActions.count()
      console.log(`PASS: Found ${actionCount} cleanup action(s)`)

      // Check for Purge button
      const purgeBtn = page.getByRole("button", { name: /Purge/i })
      if (await purgeBtn.isVisible().catch(() => false)) {
        console.log("PASS: Purge button visible")
      }

      // Check for Clean button
      const cleanBtn = page.getByRole("button", { name: /Clean/i })
      if (await cleanBtn.isVisible().catch(() => false)) {
        console.log("PASS: Clean button visible")
      }
    } else {
      console.log("PASS: All clean — no stale or blank sessions")
    }
  })

  // ------------------------------------------------------------------
  // 5. Refresh button works
  // ------------------------------------------------------------------
  test("should refresh data when Refresh button is clicked", async ({ page }) => {
    await page.goto(APP_URL)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    await openFullSettings(page)

    const activityNav = page.getByRole("button", { name: /Activity Monitor/i })
    await activityNav.click()
    await page.waitForTimeout(1500)

    // Find Refresh button
    const refreshBtn = page.getByRole("button", { name: /Refresh/i })
    await expect(refreshBtn).toBeVisible({ timeout: 5000 })
    console.log("PASS: Refresh button visible")

    await page.screenshot({ path: "test-screenshots/EC-054-05-before-refresh.png", fullPage: true })

    // Click refresh
    await refreshBtn.click()
    await page.waitForTimeout(1500)

    await page.screenshot({ path: "test-screenshots/EC-054-06-after-refresh.png", fullPage: true })

    // Summary stats should still be visible after refresh
    const statCards = page.locator(".activity-monitor-stats .activity-monitor-stat")
    await expect(statCards.first()).toBeVisible({ timeout: 5000 })
    console.log("PASS: Data refreshed — summary stats still visible")
  })

  // ------------------------------------------------------------------
  // 6. CSS is loaded correctly
  // ------------------------------------------------------------------
  test("should have activity-monitor CSS loaded", async ({ page }) => {
    await page.goto(APP_URL)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3000)

    const styleLoaded = await page.evaluate(() => {
      const styles = document.styleSheets
      for (const sheet of styles) {
        try {
          const rules = sheet.cssRules || sheet.rules
          for (const rule of rules) {
            if (
              rule.cssText?.includes("activity-monitor-stats") ||
              rule.cssText?.includes("activity-monitor-stat")
            ) {
              return true
            }
          }
        } catch (e) {
          // cross-origin sheet
        }
      }
      return false
    })

    console.log("Activity Monitor CSS loaded:", styleLoaded)
    expect(styleLoaded).toBe(true)
  })

  // ------------------------------------------------------------------
  // 7. API endpoints respond correctly
  // ------------------------------------------------------------------
  test("GET /api/sessions/stats should return valid stats", async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/sessions/stats`)
    expect(response.ok()).toBeTruthy()

    const data = await response.json()
    console.log("Session stats:", JSON.stringify(data))

    expect(data).toHaveProperty("total")
    expect(data).toHaveProperty("projectCount")
    expect(data).toHaveProperty("staleCount")
    expect(data).toHaveProperty("blankCount")
    expect(typeof data.total).toBe("number")
    expect(typeof data.projectCount).toBe("number")
    expect(typeof data.staleCount).toBe("number")
    expect(typeof data.blankCount).toBe("number")
    expect(data.total).toBeGreaterThanOrEqual(0)
    expect(data.staleCount).toBeLessThanOrEqual(data.total)
    expect(data.blankCount).toBeLessThanOrEqual(data.total)
    console.log("PASS: /api/sessions/stats returns valid data")
  })

  // ------------------------------------------------------------------
  // 8. Orphan section hidden when no orphans
  // ------------------------------------------------------------------
  test("should hide orphan section when no orphans exist", async ({ page }) => {
    await page.goto(APP_URL)
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2000)

    await openFullSettings(page)

    const activityNav = page.getByRole("button", { name: /Activity Monitor/i })
    await activityNav.click()
    await page.waitForTimeout(1500)

    // Get the orphan count from the summary stat
    const orphanStat = page.locator(".activity-monitor-stat").nth(2)
    const orphanValue = await orphanStat.locator(".activity-monitor-stat-value").textContent()
    const orphanCount = parseInt(orphanValue ?? "0", 10)

    console.log(`Orphan count: ${orphanCount}`)

    // Look for orphan subsection title
    const orphanTitle = page.locator("h3").filter({ hasText: /Orphaned Processes/i })

    if (orphanCount === 0) {
      // Orphan section should be hidden
      await expect(orphanTitle).not.toBeVisible()
      console.log("PASS: Orphan section hidden when count is 0")
    } else {
      // Orphan section should be visible with Kill All button
      await expect(orphanTitle).toBeVisible()
      const killAllBtn = page.getByRole("button", { name: /Kill All/i })
      await expect(killAllBtn).toBeVisible()
      console.log("PASS: Orphan section visible with Kill All button")
    }

    await page.screenshot({ path: "test-screenshots/EC-054-07-orphan-section.png", fullPage: true })
  })
})
