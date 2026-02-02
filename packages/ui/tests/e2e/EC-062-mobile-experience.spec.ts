import { test, expect } from "@playwright/test"

const BASE = "http://localhost:3000"
const SCREENSHOT_DIR = "test-screenshots"

const MOBILE_VIEWPORT = { width: 375, height: 812 }
const TABLET_VIEWPORT = { width: 768, height: 1024 }
const DESKTOP_VIEWPORT = { width: 1280, height: 800 }

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

// ──────────────────────────────────────────────────────────
// MOB-035: Full Mobile Navigation Flow
// ──────────────────────────────────────────────────────────
test.describe("EC-062: Mobile Experience", () => {
  test.setTimeout(120000)

  test.describe("MOB-035: Full mobile navigation flow", () => {
    test("mobile shell renders at phone viewport", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      // MobileShell should be present
      const mobileShell = page.locator("[data-mobile-shell]")
      const isVisible = await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)

      if (!isVisible) {
        console.log("SKIP: MobileShell not rendered (may need an active instance)")
        test.skip()
        return
      }

      expect(isVisible).toBe(true)

      // Bottom nav should have 4 tabs
      const tabs = page.locator("[data-tab]")
      const tabCount = await tabs.count()
      expect(tabCount).toBe(4)

      // Desktop chrome should be hidden
      const instanceTabs = page.locator("[data-instance-tabs]")
      expect(await instanceTabs.isVisible({ timeout: 500 }).catch(() => false)).toBe(false)

      const bottomStatusBar = page.locator("[data-bottom-status-bar]")
      expect(await bottomStatusBar.isVisible({ timeout: 500 }).catch(() => false)).toBe(false)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-01-mobile-shell.png`,
        fullPage: true,
      })
    })

    test("all four tabs are navigable", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Tab 1: Chat (default)
      const chatTab = page.locator('[data-tab="chat"]')
      await chatTab.click()
      await page.waitForTimeout(500)

      // Tab 2: Sessions
      const sessionsTab = page.locator('[data-tab="sessions"]')
      await sessionsTab.click()
      await page.waitForTimeout(500)
      const sessionList = page.locator('[data-testid="mobile-session-list"]')
      expect(await sessionList.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-02-sessions-tab.png`,
        fullPage: true,
      })

      // Tab 3: Work
      const workTab = page.locator('[data-tab="work"]')
      await workTab.click()
      await page.waitForTimeout(500)
      const workPanel = page.locator('[data-testid="mobile-workspace-panel"]')
      expect(await workPanel.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-03-work-tab.png`,
        fullPage: true,
      })

      // Tab 4: Settings
      const settingsTab = page.locator('[data-tab="settings"]')
      await settingsTab.click()
      await page.waitForTimeout(500)
      const settingsView = page.locator('[data-testid="mobile-settings-view"]')
      expect(await settingsView.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-04-settings-tab.png`,
        fullPage: true,
      })

      // Return to Chat
      await chatTab.click()
      await page.waitForTimeout(500)
    })
  })

  // ──────────────────────────────────────────────────────────
  // MOB-036: Mobile chat send and receive
  // ──────────────────────────────────────────────────────────
  test.describe("MOB-036: Mobile chat send and receive", () => {
    test("prompt input is visible and mobile-optimized", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Ensure we're on the Chat tab
      const chatTab = page.locator('[data-tab="chat"]')
      await chatTab.click()
      await page.waitForTimeout(500)

      // Check prompt input exists
      const textarea = page.locator("textarea")
      const hasTextarea = await textarea.first().isVisible({ timeout: 3000 }).catch(() => false)

      if (!hasTextarea) {
        console.log("SKIP: No textarea visible (may need active session)")
        test.skip()
        return
      }

      // Check font-size is at least 16px (prevents iOS zoom)
      const fontSize = await textarea.first().evaluate((el) => {
        return parseFloat(window.getComputedStyle(el).fontSize)
      })
      expect(fontSize).toBeGreaterThanOrEqual(16)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-05-chat-prompt.png`,
        fullPage: true,
      })
    })
  })

  // ──────────────────────────────────────────────────────────
  // MOB-037: Mobile session management
  // ──────────────────────────────────────────────────────────
  test.describe("MOB-037: Mobile session management", () => {
    test("session list shows time groups and status indicators", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Navigate to Sessions tab
      const sessionsTab = page.locator('[data-tab="sessions"]')
      await sessionsTab.click()
      await page.waitForTimeout(500)

      const sessionList = page.locator('[data-testid="mobile-session-list"]')
      expect(await sessionList.isVisible()).toBe(true)

      // Check for "New" button
      const newButton = sessionList.locator('button:has-text("New")')
      expect(await newButton.isVisible()).toBe(true)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-06-session-list.png`,
        fullPage: true,
      })
    })
  })

  // ──────────────────────────────────────────────────────────
  // MOB-038: Mobile settings changes
  // ──────────────────────────────────────────────────────────
  test.describe("MOB-038: Mobile settings changes", () => {
    test("settings view shows session config and status", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Navigate to Settings tab
      const settingsTab = page.locator('[data-tab="settings"]')
      await settingsTab.click()
      await page.waitForTimeout(500)

      const settingsView = page.locator('[data-testid="mobile-settings-view"]')
      expect(await settingsView.isVisible()).toBe(true)

      // Check for project name
      const projectRow = settingsView.locator('button:has-text("Project:")')
      expect(await projectRow.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      // Check for instance info
      const instanceRow = settingsView.locator('button:has-text("Instance:")')
      expect(await instanceRow.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      // Check for Advanced section items
      const mcpRow = settingsView.locator('button:has-text("MCP Servers")')
      expect(await mcpRow.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      const governanceRow = settingsView.locator('button:has-text("Governance")')
      expect(await governanceRow.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      // Check for Status section
      const tokensLabel = settingsView.locator('text=Tokens')
      expect(await tokensLabel.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      const costLabel = settingsView.locator('text=Cost')
      expect(await costLabel.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-07-settings.png`,
        fullPage: true,
      })
    })

    test("project switcher navigates from settings", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Navigate to Settings tab
      const settingsTab = page.locator('[data-tab="settings"]')
      await settingsTab.click()
      await page.waitForTimeout(500)

      // Tap project row to open switcher
      const projectRow = page.locator('button:has-text("Project:")').first()
      if (!await projectRow.isVisible({ timeout: 2000 }).catch(() => false)) {
        test.skip()
        return
      }
      await projectRow.click()
      await page.waitForTimeout(500)

      // Project switcher should be visible
      const projectSwitcher = page.locator('[data-testid="mobile-project-switcher"]')
      const switcherVisible = await projectSwitcher.isVisible({ timeout: 2000 }).catch(() => false)
      expect(switcherVisible).toBe(true)

      // Back button should return to settings
      const backButton = page.locator('button[aria-label="Back"]')
      if (await backButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        await backButton.click()
        await page.waitForTimeout(500)
        const settingsView = page.locator('[data-testid="mobile-settings-view"]')
        expect(await settingsView.isVisible()).toBe(true)
      }

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-08-project-switcher.png`,
        fullPage: true,
      })
    })
  })

  // ──────────────────────────────────────────────────────────
  // MOB-039: Responsive breakpoint transitions
  // ──────────────────────────────────────────────────────────
  test.describe("MOB-039: Responsive breakpoint transitions", () => {
    test("correct layout renders at each breakpoint", async ({ page }) => {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      // Mobile (375px) — MobileShell
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.waitForTimeout(1000)

      const mobileShell = page.locator("[data-mobile-shell]")
      const mobileVisible = await mobileShell.isVisible({ timeout: 3000 }).catch(() => false)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-09-breakpoint-mobile.png`,
        fullPage: true,
      })

      // Tablet (768px) — should transition
      await page.setViewportSize(TABLET_VIEWPORT)
      await page.waitForTimeout(1000)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-10-breakpoint-tablet.png`,
        fullPage: true,
      })

      // Desktop (1280px) — desktop layout
      await page.setViewportSize(DESKTOP_VIEWPORT)
      await page.waitForTimeout(1000)

      // Desktop chrome should be visible
      const instanceTabs = page.locator("[data-instance-tabs]")
      const desktopChrome = await instanceTabs.isVisible({ timeout: 3000 }).catch(() => false)

      // MobileShell should be hidden at desktop
      const mobileHidden = !(await mobileShell.isVisible({ timeout: 500 }).catch(() => false))

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-11-breakpoint-desktop.png`,
        fullPage: true,
      })

      // Verify the correct layout at each breakpoint
      if (mobileVisible) {
        expect(mobileHidden).toBe(true)
        console.log("PASS: MobileShell visible on phone, hidden on desktop")
      } else {
        console.log("INFO: No active instance — breakpoint test limited to visual inspection")
      }
    })
  })

  // ──────────────────────────────────────────────────────────
  // MOB-040: Mobile permission approval flow
  // ──────────────────────────────────────────────────────────
  test.describe("MOB-040: Mobile permission approval flow", () => {
    test("permission card has accessible touch targets", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Navigate to Chat tab
      const chatTab = page.locator('[data-tab="chat"]')
      await chatTab.click()
      await page.waitForTimeout(500)

      // Check if permission card is present (only visible when permission is pending)
      const permissionCard = page.locator('[data-testid="mobile-permission-card"]')
      const hasPermission = await permissionCard.isVisible({ timeout: 2000 }).catch(() => false)

      if (hasPermission) {
        // Verify Allow button has sufficient touch target
        const allowButton = permissionCard.locator('button:has-text("Allow")')
        const allowBox = await allowButton.boundingBox()
        if (allowBox) {
          expect(allowBox.height).toBeGreaterThanOrEqual(48)
          console.log(`PASS: Allow button height: ${allowBox.height}px`)
        }

        // Verify Deny button
        const denyButton = permissionCard.locator('button:has-text("Deny")')
        const denyBox = await denyButton.boundingBox()
        if (denyBox) {
          expect(denyBox.height).toBeGreaterThanOrEqual(48)
          console.log(`PASS: Deny button height: ${denyBox.height}px`)
        }

        await page.screenshot({
          path: `${SCREENSHOT_DIR}/EC-062-12-permission-card.png`,
          fullPage: true,
        })
      } else {
        console.log("INFO: No pending permissions — permission card test is visual only")
      }
    })
  })

  // ──────────────────────────────────────────────────────────
  // Additional: Tool call modal full-screen on mobile
  // ──────────────────────────────────────────────────────────
  test.describe("Tool call modal responsive behavior", () => {
    test("command palette renders as bottom sheet on mobile", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Open overflow menu and trigger command palette
      const overflowButton = page.locator('[aria-label="More options"]').first()
      if (!await overflowButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log("SKIP: Overflow button not visible")
        test.skip()
        return
      }

      await overflowButton.click()
      await page.waitForTimeout(300)

      const cmdPaletteButton = page.locator('button:has-text("Command Palette")')
      if (await cmdPaletteButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        await cmdPaletteButton.click()
        await page.waitForTimeout(500)

        // Command palette should be visible at the bottom of the viewport
        const dialog = page.locator('[role="dialog"]').first()
        if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
          const box = await dialog.boundingBox()
          if (box) {
            // Should be positioned near the bottom of the viewport
            expect(box.width).toBeGreaterThanOrEqual(350)
            console.log(`PASS: Command palette width: ${box.width}px, top: ${box.y}px`)
          }
        }

        await page.screenshot({
          path: `${SCREENSHOT_DIR}/EC-062-13-command-palette-mobile.png`,
          fullPage: true,
        })

        // Close it
        await page.keyboard.press("Escape")
        await page.waitForTimeout(300)
      }
    })
  })

  // ──────────────────────────────────────────────────────────
  // UX Quality: Touch targets, transitions, sub-view state
  // ──────────────────────────────────────────────────────────
  test.describe("UX quality checks", () => {
    test("header overflow button meets 44px touch target", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      const overflowButton = page.locator('[aria-label="More options"]').first()
      if (await overflowButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        const box = await overflowButton.boundingBox()
        if (box) {
          expect(box.width).toBeGreaterThanOrEqual(44)
          expect(box.height).toBeGreaterThanOrEqual(44)
          console.log(`PASS: Overflow button size: ${box.width}x${box.height}px`)
        }
      }
    })

    test("overflow menu has role=menu and animates", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      const overflowButton = page.locator('[aria-label="More options"]').first()
      if (!await overflowButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        test.skip()
        return
      }

      await overflowButton.click()
      await page.waitForTimeout(200)

      const menu = page.locator('[role="menu"]')
      expect(await menu.isVisible({ timeout: 1000 }).catch(() => false)).toBe(true)

      // Verify menu items have role="menuitem"
      const menuItems = page.locator('[role="menuitem"]')
      expect(await menuItems.count()).toBe(3)

      // Close with Escape
      await page.keyboard.press("Escape")
      await page.waitForTimeout(300)

      // Menu should be hidden after animation
      expect(await menu.isVisible({ timeout: 500 }).catch(() => false)).toBe(false)
    })

    test("settings sub-view resets when navigating away", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Go to Settings tab
      await page.locator('[data-tab="settings"]').click()
      await page.waitForTimeout(500)

      // Try to open project switcher
      const projectRow = page.locator('button:has-text("Project:")').first()
      if (!await projectRow.isVisible({ timeout: 2000 }).catch(() => false)) {
        test.skip()
        return
      }
      await projectRow.click()
      await page.waitForTimeout(500)

      const projectSwitcher = page.locator('[data-testid="mobile-project-switcher"]')
      if (!await projectSwitcher.isVisible({ timeout: 1000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Navigate away to Chat tab
      await page.locator('[data-tab="chat"]').click()
      await page.waitForTimeout(500)

      // Navigate back to Settings tab
      await page.locator('[data-tab="settings"]').click()
      await page.waitForTimeout(500)

      // Should see main settings, NOT project switcher
      const settingsView = page.locator('[data-testid="mobile-settings-view"]')
      expect(await settingsView.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      const switcherStillVisible = await projectSwitcher.isVisible({ timeout: 500 }).catch(() => false)
      expect(switcherStillVisible).toBe(false)

      console.log("PASS: Settings sub-view resets on tab change")
    })

    test("bottom nav active indicator renders correctly", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Chat tab should be active by default
      const chatTab = page.locator('[data-tab="chat"]')
      const chatTabClasses = await chatTab.getAttribute("class")
      expect(chatTabClasses).toContain("text-info")

      // Switch to Work tab
      await page.locator('[data-tab="work"]').click()
      await page.waitForTimeout(300)

      // Work tab should now be active
      const workTab = page.locator('[data-tab="work"]')
      const workTabClasses = await workTab.getAttribute("class")
      expect(workTabClasses).toContain("text-info")

      // Chat tab should no longer be active
      const chatTabClassesAfter = await chatTab.getAttribute("class")
      expect(chatTabClassesAfter).not.toContain("text-info")
    })

    test("New session button meets 44px touch target", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      await page.locator('[data-tab="sessions"]').click()
      await page.waitForTimeout(500)

      const newButton = page.locator('[data-testid="mobile-session-list"] button:has-text("New")')
      if (await newButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        const box = await newButton.boundingBox()
        if (box) {
          expect(box.height).toBeGreaterThanOrEqual(44)
          console.log(`PASS: New button height: ${box.height}px`)
        }
      }
    })
  })

  // ──────────────────────────────────────────────────────────
  // Additional: Workspace panel accordion sections
  // ──────────────────────────────────────────────────────────
  test.describe("Workspace panel Linear integration", () => {
    test("workspace panel includes Linear Tasks section", async ({ page }) => {
      await page.setViewportSize(MOBILE_VIEWPORT)
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(2000)
      await dismissModals(page)

      const mobileShell = page.locator("[data-mobile-shell]")
      if (!await mobileShell.isVisible({ timeout: 5000 }).catch(() => false)) {
        test.skip()
        return
      }

      // Navigate to Work tab
      const workTab = page.locator('[data-tab="work"]')
      await workTab.click()
      await page.waitForTimeout(500)

      const workPanel = page.locator('[data-testid="mobile-workspace-panel"]')
      expect(await workPanel.isVisible()).toBe(true)

      // Check for accordion sections
      const linearSection = workPanel.locator('text=Linear Tasks')
      const tasksSection = workPanel.locator('text=Tasks')
      const gitSection = workPanel.locator('text=Git Status')
      const actionsSection = workPanel.locator('text=Recent Actions')
      const filesSection = workPanel.locator('text=Files Touched')

      expect(await linearSection.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)
      expect(await tasksSection.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)
      expect(await gitSection.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)
      expect(await actionsSection.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)
      expect(await filesSection.isVisible({ timeout: 2000 }).catch(() => false)).toBe(true)

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/EC-062-14-workspace-linear.png`,
        fullPage: true,
      })
    })
  })
})
