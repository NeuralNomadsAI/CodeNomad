import { test, expect, devices } from "@playwright/test"

const BASE = "http://localhost:3000"
const SCREENSHOT_DIR = "test-screenshots/mobile-audit"

// iPhone 14 Pro Max: 430x932 screen, 430x740 viewport, 3x scale, mobile, touch
const { defaultBrowserType: _, ...deviceConfig } = devices["iPhone 14 Pro Max"]

type Page = import("@playwright/test").Page

async function dismissModals(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const text of ["Proceed with auto-approve", "Proceed", "Continue", "OK", "Accept", "Close"]) {
      const btn = page.locator(`button:has-text("${text}")`).first()
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        await btn.click({ force: true, timeout: 2000 }).catch(() => {})
        await page.waitForTimeout(300)
      }
    }
  }
  await page.keyboard.press("Escape")
  await page.waitForTimeout(200)
}

/** Get the visible mobile shell — scopes all queries to the active instance */
function activeShell(page: Page) {
  return page.locator("[data-mobile-shell]").filter({ visible: true }).first()
}

/** Click a tab within the active mobile shell's bottom nav */
async function clickTab(page: Page, tabId: string) {
  // Use Playwright's .filter({ visible: true }) instead of CSS :visible
  const tab = page.locator(`[data-tab="${tabId}"]`).filter({ visible: true }).first()
  if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
    await tab.click()
    await page.waitForTimeout(300)
    return
  }
  // If no visible tab, the shell may have lost activation — re-press Meta+1
  console.log(`Tab "${tabId}" not visible, re-activating shell...`)
  await page.keyboard.press("Meta+1")
  await page.waitForTimeout(1000)
  const retryTab = page.locator(`[data-tab="${tabId}"]`).filter({ visible: true }).first()
  await retryTab.click({ timeout: 5000 })
  await page.waitForTimeout(300)
}

/** Poll until mobile shell becomes visible, dismissing modals along the way */
async function waitForMobileShell(page: Page, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const text of ["Proceed with auto-approve", "Proceed", "Continue", "OK", "Accept", "Close"]) {
      const btn = page.locator(`button:has-text("${text}")`).first()
      if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
        console.log(`Dismissing modal: "${text}"`)
        await btn.click({ force: true, timeout: 1000 }).catch(() => {})
        await page.waitForTimeout(300)
      }
    }
    const visible = await activeShell(page).isVisible({ timeout: 500 }).catch(() => false)
    if (visible) return true
    await page.waitForTimeout(500)
  }
  return false
}

/** Open a workspace by activating an existing instance or creating one */
async function openWorkspace(page: Page): Promise<boolean> {
  if (await waitForMobileShell(page, 2000)) return true

  // Wait for instances to load from server
  console.log("Waiting for instances to load from server...")
  const deadline = Date.now() + 10000
  let shellsInDom = 0
  while (Date.now() < deadline) {
    shellsInDom = await page.locator("[data-mobile-shell]").count()
    if (shellsInDom > 0) break
    await page.waitForTimeout(500)
  }

  if (shellsInDom > 0) {
    console.log(`Found ${shellsInDom} instance(s) in DOM, pressing Meta+1 to activate...`)
    await page.keyboard.press("Meta+1")
    await page.waitForTimeout(500)
    if (await waitForMobileShell(page, 5000)) return true

    console.log("Meta+1 didn't work, trying Control+1...")
    await page.keyboard.press("Control+1")
    await page.waitForTimeout(500)
    if (await waitForMobileShell(page, 5000)) return true
    console.log("Keyboard shortcut didn't activate instance")
  }

  // Fallback: Click a recent folder
  const firstFolder = page.locator("[data-folder-index='0']")
  if (await firstFolder.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log("Clicking recent folder...")
    await firstFolder.click()
    if (await waitForMobileShell(page, 20000)) return true
    console.log("MobileShell not visible after clicking recent folder")
  }

  const html = await page.evaluate(() => document.body.innerHTML.substring(0, 500))
  console.log("Page HTML (first 500):", html)
  return false
}

/** Check horizontal overflow and log overflowing elements */
async function checkOverflow(page: Page, label: string): Promise<boolean> {
  const bodyWidth = await page.evaluate(() => document.body.scrollWidth)
  const viewportWidth = await page.evaluate(() => window.innerWidth)
  const hasOverflow = bodyWidth > viewportWidth
  console.log(`[${label}] body=${bodyWidth}px viewport=${viewportWidth}px overflow=${hasOverflow}`)

  if (hasOverflow) {
    const overflows = await page.evaluate(() => {
      const vw = window.innerWidth
      const results: string[] = []
      document.querySelectorAll("*").forEach((el) => {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.right > vw + 2) {
          const tag = el.tagName.toLowerCase()
          const id = el.id ? `#${el.id}` : ""
          const cls = (el.className?.toString() || "").slice(0, 60)
          results.push(`${tag}${id} cls="${cls}" right=${Math.round(rect.right)}px`)
        }
      })
      return results.slice(0, 10)
    })
    console.log(`  Overflowing elements:`)
    overflows.forEach((o) => console.log(`    ${o}`))
  }

  return hasOverflow
}

test.describe("EC-063: iPhone 14 Pro Max Full Mobile Audit", () => {
  test.setTimeout(180000)

  test.use({
    ...deviceConfig,
  })

  test("00 — Landing page mobile responsiveness", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/00-landing-page.png`, fullPage: false })
    await checkOverflow(page, "Landing")

    const cards = await page.locator(".grid > div").count()
    console.log(`Landing page card count: ${cards}`)

    const searchInput = page.locator("input[placeholder*='Search folders']").first()
    if (await searchInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      const box = await searchInput.boundingBox()
      console.log(`Search input: ${box ? `${Math.round(box.width)}x${Math.round(box.height)}px` : "no box"}`)
    }

    const hasRecent = await page.locator("[data-folder-index='0']").isVisible({ timeout: 1000 }).catch(() => false)
    console.log(`Has recent folders: ${hasRecent}`)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/00-landing-page-full.png`, fullPage: true })
  })

  test("01 — Open workspace and verify mobile shell", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    const hasMobileShell = await openWorkspace(page)
    console.log(`Mobile shell visible: ${hasMobileShell}`)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-after-open-workspace.png`, fullPage: false })

    if (hasMobileShell) {
      const shell = activeShell(page)
      const hasHeader = await shell.locator("[data-mobile-header]").isVisible().catch(() => false)
      console.log(`Header visible in active shell: ${hasHeader}`)

      // Check visible bottom nav
      const hasNav = await page.locator("[data-mobile-bottom-nav]:visible").first().isVisible().catch(() => false)
      console.log(`Bottom nav visible: ${hasNav}`)

      const visibleTabs = await page.locator("[data-mobile-bottom-nav]:visible [data-tab]").count()
      console.log(`Visible tabs: ${visibleTabs}`)

      // Verify no desktop chrome
      const hasInstanceTabs = await page.locator("[data-instance-tabs]").isVisible().catch(() => false)
      const hasBottomStatus = await page.locator("[data-bottom-status-bar]").isVisible().catch(() => false)
      console.log(`Desktop chrome: instanceTabs=${hasInstanceTabs} bottomStatusBar=${hasBottomStatus}`)

      await checkOverflow(page, "Workspace")
    } else {
      const info = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
        mobileQuery: window.matchMedia("(max-width: 767px)").matches,
      }))
      console.log("Viewport:", JSON.stringify(info))
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-after-open-workspace-full.png`, fullPage: true })
  })

  test("02 — Chat tab layout and prompt input", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!await openWorkspace(page)) {
      console.log("SKIP: Could not open workspace")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/02-chat-NO-WORKSPACE.png`, fullPage: true })
      return
    }

    await page.waitForTimeout(1000)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-chat-tab.png`, fullPage: false })

    // Check prompt input
    const textarea = page.locator("textarea").first()
    const hasTextarea = await textarea.isVisible({ timeout: 3000 }).catch(() => false)
    console.log(`Prompt textarea visible: ${hasTextarea}`)

    if (hasTextarea) {
      const styles = await textarea.evaluate((el) => {
        const cs = window.getComputedStyle(el)
        return { fontSize: parseFloat(cs.fontSize), height: parseFloat(cs.height), width: parseFloat(cs.width) }
      })
      console.log(`Textarea: font=${styles.fontSize}px, ${Math.round(styles.width)}x${Math.round(styles.height)}px`)
      if (styles.fontSize < 16) console.log("WARNING: font-size < 16px triggers iOS zoom")
    }

    // Check welcome/placeholder state
    if (await page.locator("text=Resume a Session").first().isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log("Welcome view visible (no sessions)")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/02-chat-welcome-view.png`, fullPage: false })
    }
    if (await page.locator("text=Select a session to begin").first().isVisible({ timeout: 500 }).catch(() => false)) {
      console.log("Session placeholder visible (sessions exist but none selected)")
    }

    await checkOverflow(page, "Chat")
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-chat-tab-full.png`, fullPage: true })
  })

  test("03 — Sessions tab", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!await openWorkspace(page)) {
      console.log("SKIP: Could not open workspace")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/03-sessions-NO-WORKSPACE.png`, fullPage: true })
      return
    }

    await clickTab(page, "sessions")
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-sessions-tab.png`, fullPage: false })

    const sessionList = page.locator('[data-testid="mobile-session-list"]').first()
    const hasSessionList = await sessionList.isVisible({ timeout: 2000 }).catch(() => false)
    console.log(`Session list visible: ${hasSessionList}`)

    if (hasSessionList) {
      const newBtn = sessionList.locator('button:has-text("New")')
      if (await newBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        const box = await newBtn.boundingBox()
        console.log(`New button: ${box ? `${Math.round(box.width)}x${Math.round(box.height)}px` : "no box"} (min 44px)`)
        if (box && box.height < 44) console.log("WARNING: New button below 44px")
      }

      const rowCount = await sessionList.locator("button.w-full").count()
      console.log(`Session rows: ${rowCount}`)

      const headers = sessionList.locator(".uppercase.tracking-wider")
      const headerCount = await headers.count()
      for (let i = 0; i < headerCount; i++) {
        console.log(`  Time group: "${(await headers.nth(i).textContent())?.trim()}"`)
      }
    }

    await checkOverflow(page, "Sessions")
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-sessions-tab-full.png`, fullPage: true })
  })

  test("04 — Work tab", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!await openWorkspace(page)) {
      console.log("SKIP: Could not open workspace")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/04-work-NO-WORKSPACE.png`, fullPage: true })
      return
    }

    await clickTab(page, "work")
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-work-tab.png`, fullPage: false })

    const workPanel = page.locator('[data-testid="mobile-workspace-panel"]').first()
    const hasWorkPanel = await workPanel.isVisible({ timeout: 2000 }).catch(() => false)
    console.log(`Work panel visible: ${hasWorkPanel}`)

    if (hasWorkPanel) {
      for (const section of ["Linear Tasks", "Tasks", "Git Status", "Recent Actions", "Files Touched"]) {
        const visible = await workPanel.locator(`text=${section}`).isVisible({ timeout: 1000 }).catch(() => false)
        console.log(`  "${section}": ${visible ? "OK" : "MISSING"}`)
      }

      const accordionBtns = workPanel.locator("button:has(svg)")
      const count = await accordionBtns.count()
      for (let i = 0; i < Math.min(count, 5); i++) {
        const box = await accordionBtns.nth(i).boundingBox()
        if (box) {
          const text = await accordionBtns.nth(i).textContent()
          console.log(`  Accordion "${text?.trim().substring(0, 20)}": ${Math.round(box.height)}px height`)
          if (box.height < 44) console.log(`  WARNING: Below 44px`)
        }
      }
    }

    await checkOverflow(page, "Work")
    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-work-tab-full.png`, fullPage: true })
  })

  test("05 — Settings tab", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!await openWorkspace(page)) {
      console.log("SKIP: Could not open workspace")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/05-settings-NO-WORKSPACE.png`, fullPage: true })
      return
    }

    await clickTab(page, "settings")
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-settings-tab.png`, fullPage: false })

    const settingsView = page.locator('[data-testid="mobile-settings-view"]').first()
    const hasSettings = await settingsView.isVisible({ timeout: 2000 }).catch(() => false)
    console.log(`Settings view visible: ${hasSettings}`)

    if (hasSettings) {
      for (const label of [
        "Session Configuration", "Project:", "Instance:",
        "MCP Servers", "LSP Servers", "Linear",
        "Governance", "Directives", "Full Settings",
        "Tokens", "Cost",
      ]) {
        const visible = await settingsView.locator(`text=${label}`).first().isVisible({ timeout: 800 }).catch(() => false)
        console.log(`  "${label}": ${visible ? "OK" : "MISSING"}`)
      }

      const navRows = settingsView.locator("button:has(svg.lucide-chevron-right)")
      const navCount = await navRows.count()
      for (let i = 0; i < navCount; i++) {
        const box = await navRows.nth(i).boundingBox()
        const text = await navRows.nth(i).textContent()
        if (box) {
          console.log(`  Row "${text?.trim().substring(0, 25)}": ${Math.round(box.height)}px height`)
          if (box.height < 48) console.log(`  WARNING: Below 48px`)
        }
      }

      await settingsView.evaluate((el) => el.querySelector(".overflow-y-auto")?.scrollTo(0, 9999))
      await page.waitForTimeout(300)
    }

    await checkOverflow(page, "Settings")
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-settings-scrolled.png`, fullPage: false })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-settings-tab-full.png`, fullPage: true })
  })

  test("06 — Project Switcher sub-view", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!await openWorkspace(page)) {
      console.log("SKIP: Could not open workspace")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/06-switcher-NO-WORKSPACE.png`, fullPage: true })
      return
    }

    await clickTab(page, "settings")
    await page.waitForTimeout(800)

    const projectRow = page.locator('button:has-text("Project:")').first()
    if (!await projectRow.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log("SKIP: No project row in settings")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/06-switcher-no-project-row.png`, fullPage: true })
      return
    }

    await projectRow.click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/06-project-switcher.png`, fullPage: false })

    const switcher = page.locator('[data-testid="mobile-project-switcher"]').first()
    const hasSwitcher = await switcher.isVisible({ timeout: 2000 }).catch(() => false)
    console.log(`Project switcher visible: ${hasSwitcher}`)

    if (hasSwitcher) {
      const backBtn = switcher.locator("button:has-text('Back')").first()
      if (await backBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        const box = await backBtn.boundingBox()
        console.log(`Back button: ${box ? `${Math.round(box.width)}x${Math.round(box.height)}px` : "no box"}`)
      }
    }

    await checkOverflow(page, "ProjectSwitcher")
    await page.screenshot({ path: `${SCREENSHOT_DIR}/06-project-switcher-full.png`, fullPage: true })
  })

  test("07 — Overflow menu", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!await openWorkspace(page)) {
      console.log("SKIP: Could not open workspace")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/07-overflow-NO-WORKSPACE.png`, fullPage: true })
      return
    }

    const overflowBtn = page.locator('[aria-label="More options"]').first()
    if (!await overflowBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log("SKIP: Overflow button not visible")
      return
    }

    const btnBox = await overflowBtn.boundingBox()
    console.log(`Overflow button: ${btnBox ? `${Math.round(btnBox.width)}x${Math.round(btnBox.height)}px` : "no box"} (min 44px)`)

    await overflowBtn.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/07-overflow-menu.png`, fullPage: false })

    const menu = page.locator('[role="menu"]')
    const hasMenu = await menu.isVisible({ timeout: 1000 }).catch(() => false)
    console.log(`Menu visible: ${hasMenu}`)

    if (hasMenu) {
      const menuItems = page.locator('[role="menuitem"]')
      const itemCount = await menuItems.count()
      for (let i = 0; i < itemCount; i++) {
        const text = await menuItems.nth(i).textContent()
        const box = await menuItems.nth(i).boundingBox()
        console.log(`  "${text?.trim()}": ${box ? `${Math.round(box.width)}x${Math.round(box.height)}px` : "no box"}`)
        if (box && box.height < 48) console.log(`  WARNING: Below 48px`)
      }
    }

    await page.keyboard.press("Escape")
    await page.waitForTimeout(300)
    const menuAfterEscape = await menu.isVisible({ timeout: 500 }).catch(() => false)
    console.log(`Menu after Escape: ${menuAfterEscape ? "STILL VISIBLE (BUG)" : "dismissed (OK)"}`)
  })

  test("08 — Header and bottom nav measurements", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!await openWorkspace(page)) {
      console.log("SKIP: Could not open workspace")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/08-layout-NO-WORKSPACE.png`, fullPage: true })
      return
    }

    // Use visible selectors to avoid strict mode issues
    const header = page.locator("[data-mobile-header]").filter({ visible: true }).first()
    const hasHeader = await header.isVisible({ timeout: 2000 }).catch(() => false)
    if (hasHeader) {
      const box = await header.boundingBox()
      console.log(`Header: ${box ? `${Math.round(box.width)}x${Math.round(box.height)}px at y=${Math.round(box.y)}` : "no box"}`)
      if (box && box.height < 44) console.log("WARNING: Header below 44px")
      if (box && box.width < 430) console.log("WARNING: Header not full width")
    } else {
      console.log("Header NOT VISIBLE")
    }

    const bottomNav = page.locator("[data-mobile-bottom-nav]").filter({ visible: true }).first()
    const hasNav = await bottomNav.isVisible({ timeout: 2000 }).catch(() => false)
    if (hasNav) {
      const box = await bottomNav.boundingBox()
      console.log(`Bottom nav: ${box ? `${Math.round(box.width)}x${Math.round(box.height)}px at y=${Math.round(box.y)}` : "no box"}`)
      if (box && box.width < 430) console.log("WARNING: Bottom nav not full width")

      const tabs = bottomNav.locator("[data-tab]")
      const count = await tabs.count()
      for (let i = 0; i < count; i++) {
        const tabId = await tabs.nth(i).getAttribute("data-tab")
        const tabBox = await tabs.nth(i).boundingBox()
        console.log(`  Tab "${tabId}": ${tabBox ? `${Math.round(tabBox.width)}x${Math.round(tabBox.height)}px` : "no box"}`)
        if (tabBox && tabBox.height < 48) console.log(`  WARNING: Tab below 48px`)
      }
    } else {
      console.log("Bottom nav NOT VISIBLE")
    }

    const headerBox = hasHeader ? await header.boundingBox().catch(() => null) : null
    const navBox = hasNav ? await bottomNav.boundingBox().catch(() => null) : null
    if (headerBox && navBox) {
      const contentHeight = navBox.y - (headerBox.y + headerBox.height)
      const vh = await page.evaluate(() => window.innerHeight)
      console.log(`Content area: ${Math.round(contentHeight)}px`)
      console.log(`Total: header(${Math.round(headerBox.height)}) + content(${Math.round(contentHeight)}) + nav(${Math.round(navBox.height)}) = ${Math.round(headerBox.height + contentHeight + navBox.height)}px vs viewport ${vh}px`)
      const gap = vh - (headerBox.height + contentHeight + navBox.height)
      if (Math.abs(gap) > 2) console.log(`WARNING: Layout gap of ${Math.round(gap)}px`)
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/08-layout-measurements.png`, fullPage: false })
  })

  test("09 — Horizontal overflow audit all tabs", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!await openWorkspace(page)) {
      console.log("SKIP: Could not open workspace")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/09-overflow-NO-WORKSPACE.png`, fullPage: true })
      return
    }

    const issues: string[] = []

    for (const tabId of ["chat", "sessions", "work", "settings"] as const) {
      await clickTab(page, tabId)
      await page.waitForTimeout(1000)

      const hasOverflow = await checkOverflow(page, tabId)
      if (hasOverflow) issues.push(`${tabId} tab has horizontal overflow`)

      await page.screenshot({ path: `${SCREENSHOT_DIR}/09-overflow-${tabId}.png`, fullPage: false })
    }

    if (issues.length > 0) {
      console.log("\n=== OVERFLOW ISSUES ===")
      issues.forEach((i) => console.log(`  - ${i}`))
    } else {
      console.log("\nNo horizontal overflow detected on any tab")
    }
  })

  test("10 — Full viewport fill check", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await dismissModals(page)

    if (!await openWorkspace(page)) {
      console.log("SKIP: Could not open workspace")
      await page.screenshot({ path: `${SCREENSHOT_DIR}/10-fill-NO-WORKSPACE.png`, fullPage: true })
      return
    }

    const shell = activeShell(page)
    const shellBox = await shell.boundingBox()
    if (shellBox) {
      const vw = await page.evaluate(() => window.innerWidth)
      const vh = await page.evaluate(() => window.innerHeight)
      console.log(`Shell: ${Math.round(shellBox.width)}x${Math.round(shellBox.height)}px`)
      console.log(`Viewport: ${vw}x${vh}px`)
      console.log(`Width fill: ${((shellBox.width / vw) * 100).toFixed(1)}%`)
      console.log(`Height fill: ${((shellBox.height / vh) * 100).toFixed(1)}%`)
      if (shellBox.width < vw - 2) console.log("WARNING: Shell not filling viewport width")
      if (shellBox.height < vh - 2) console.log("WARNING: Shell not filling viewport height")
    } else {
      console.log("Shell has no bounding box")
    }

    // Screenshot all tabs
    for (const tabId of ["chat", "sessions", "work", "settings"] as const) {
      await clickTab(page, tabId)
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${SCREENSHOT_DIR}/10-fill-${tabId}.png`, fullPage: false })
    }
  })
})
