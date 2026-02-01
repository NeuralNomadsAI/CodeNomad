import { test } from "@playwright/test"

const BASE = "http://localhost:3000"
const SHOT = "./tests/e2e/screenshots/ux-audit"

/** Helper: dismiss any modal/overlay blocking the page */
async function dismissModal(page: import("@playwright/test").Page) {
  // Try clicking proceed/accept/continue buttons first
  for (const text of ["Proceed with auto-approve", "Proceed", "Continue", "OK", "Accept", "Close"]) {
    const btn = page.locator(`button:has-text("${text}")`).first()
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click()
      await page.waitForTimeout(1000)
      return true
    }
  }
  // Try Escape as fallback
  await page.keyboard.press("Escape")
  await page.waitForTimeout(500)
  return false
}

test.describe("UX Audit - Full User Flow", () => {
  test.setTimeout(180_000)

  test("full flow: home → project → session → settings", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })

    // ─── PHASE 1: HOME / PROJECT SELECTION ───────────────────────────
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(3000)
    await page.screenshot({ path: `${SHOT}/01-home-landing.png` })

    console.log(`\n=== PHASE 1: HOME ===`)
    const homeAudit = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      return {
        background: root.getPropertyValue("--background").trim(),
        secondary: root.getPropertyValue("--secondary").trim(),
        muted: root.getPropertyValue("--muted").trim(),
        accent: root.getPropertyValue("--accent").trim(),
        border: root.getPropertyValue("--border").trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      }
    })
    console.log("Tokens:", homeAudit)

    // ─── PHASE 2: OPEN A PROJECT ─────────────────────────────────────
    console.log(`\n=== PHASE 2: OPEN PROJECT ===`)

    // Check if CodeNomad tab already exists
    const existingTab = page.locator(".project-tab, [class*='project-tab']").filter({ hasText: "CodeNomad" }).first()
    const hasExistingTab = await existingTab.isVisible({ timeout: 1000 }).catch(() => false)

    if (hasExistingTab) {
      console.log("Found existing CodeNomad tab - clicking it")
      await existingTab.click()
      await page.waitForTimeout(2000)
    } else {
      // Open from folder card
      const folderCard = page.locator("text=CodeNomad").first()
      if (await folderCard.isVisible({ timeout: 2000 }).catch(() => false)) {
        await folderCard.dblclick()
        await page.waitForTimeout(3000)
      }
    }

    // Handle any modal that pops up
    await dismissModal(page)
    await page.waitForTimeout(2000)
    await page.screenshot({ path: `${SHOT}/02-project-opened.png` })

    // ─── PHASE 3: LEFT SIDEBAR AUDIT ─────────────────────────────────
    console.log(`\n=== PHASE 3: LEFT SIDEBAR ===`)

    // Try to open the left drawer if it's not visible
    const leftDrawerToggle = page.locator("button[aria-label*='sidebar' i], button[aria-label*='drawer' i], button[title*='sidebar' i]").first()
    if (await leftDrawerToggle.isVisible({ timeout: 1000 }).catch(() => false)) {
      await leftDrawerToggle.click()
      await page.waitForTimeout(1000)
    }

    await page.screenshot({ path: `${SHOT}/03-left-sidebar.png` })

    const sidebarAudit = await page.evaluate(() => {
      const allElements = document.querySelectorAll("*")
      const bgMap = new Map<string, number>()
      allElements.forEach((el) => {
        const bg = getComputedStyle(el).backgroundColor
        if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
          bgMap.set(bg, (bgMap.get(bg) || 0) + 1)
        }
      })
      return {
        uniqueBgs: [...bgMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
        sessionTabs: document.querySelectorAll(".session-tab, [class*='session-tab']").length,
      }
    })

    console.log(`Session tabs visible: ${sidebarAudit.sessionTabs}`)
    console.log(`Unique background colors on page:`)
    sidebarAudit.uniqueBgs.forEach(([color, count]) => console.log(`  ${count}x ${color}`))

    // ─── PHASE 4: NAVIGATE TO A SESSION WITH MESSAGES ────────────────
    console.log(`\n=== PHASE 4: SESSION WITH MESSAGES ===`)

    const sessionTabs = page.locator(".session-tab, [class*='session-tab']")
    const sessionCount = await sessionTabs.count()
    console.log(`Found ${sessionCount} session tabs`)

    let foundSessionWithMessages = false
    for (let i = 0; i < Math.min(sessionCount, 5); i++) {
      const tab = sessionTabs.nth(i)
      const tabText = await tab.textContent().catch(() => "")
      console.log(`  Tab ${i}: "${tabText?.trim()}"`)

      await tab.click()
      await page.waitForTimeout(2000)

      // Check if this session has messages
      const msgCount = await page.locator(".message-section, .message-block, [class*='message-section']").count()
      if (msgCount > 0) {
        console.log(`  -> Has ${msgCount} messages!`)
        foundSessionWithMessages = true
        await page.screenshot({ path: `${SHOT}/04-session-messages-top.png` })

        // Scroll through messages
        const stream = page.locator(".message-stream-content, .message-stream, [class*='overflow-y-auto']").first()
        if (await stream.isVisible().catch(() => false)) {
          await stream.evaluate((el) => (el.scrollTop = el.scrollHeight * 0.4))
          await page.waitForTimeout(1000)
          await page.screenshot({ path: `${SHOT}/05-session-messages-mid.png` })

          await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
          await page.waitForTimeout(1000)
          await page.screenshot({ path: `${SHOT}/06-session-messages-bottom.png` })

          // Scroll back to top for a clean slate
          await stream.evaluate((el) => (el.scrollTop = 0))
          await page.waitForTimeout(500)
        }
        break
      }
    }

    if (!foundSessionWithMessages) {
      console.log("No sessions with messages found - screenshotting empty state")
      await page.screenshot({ path: `${SHOT}/04-empty-session.png` })
    }

    // Audit message area styling
    const messageAudit = await page.evaluate(() => {
      const msgs = document.querySelectorAll(".message-section, .message-block, [class*='message-section']")
      const samples: string[] = []
      msgs.forEach((msg, i) => {
        if (i < 8) {
          const cs = getComputedStyle(msg)
          const text = (msg.textContent || "").trim().substring(0, 50)
          samples.push(`msg${i}: bg=${cs.backgroundColor} border=${cs.borderColor} pad=${cs.padding} "${text}"`)
        }
      })

      const timeline = document.querySelector(".message-timeline, [class*='message-timeline']")
      const promptInput = document.querySelector(".prompt-input, textarea")
      const toolCalls = document.querySelectorAll(".tool-call-group-container, .tool-row, [class*='tool-call']")

      const inputInfo: Record<string, string> = {}
      if (promptInput) {
        const cs = getComputedStyle(promptInput)
        inputInfo.bg = cs.backgroundColor
        inputInfo.border = cs.borderColor
        inputInfo.borderRadius = cs.borderRadius
        inputInfo.padding = cs.padding
      }

      return {
        messageCount: msgs.length,
        hasTimeline: !!timeline,
        toolCallCount: toolCalls.length,
        inputInfo,
        samples,
      }
    })

    console.log(`Messages: ${messageAudit.messageCount}, Timeline: ${messageAudit.hasTimeline}, Tools: ${messageAudit.toolCallCount}`)
    console.log(`Input:`, messageAudit.inputInfo)
    messageAudit.samples.forEach((s) => console.log(`  ${s}`))

    // ─── PHASE 5: HOVER STATES ───────────────────────────────────────
    console.log(`\n=== PHASE 5: HOVER STATES ===`)

    if (sessionCount > 1) {
      // Hover non-active tab
      const nonActiveTab = sessionTabs.nth(sessionCount > 1 ? 1 : 0)
      await nonActiveTab.hover()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${SHOT}/07-hover-session-tab.png` })
    }

    // Hover tool calls if visible
    const toolRow = page.locator(".tool-row, [class*='tool-call']").first()
    if (await toolRow.isVisible({ timeout: 500 }).catch(() => false)) {
      await toolRow.hover()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${SHOT}/08-hover-tool-call.png` })
    }

    // ─── PHASE 6: QUICK SETTINGS ─────────────────────────────────────
    console.log(`\n=== PHASE 6: QUICK SETTINGS ===`)

    // Dismiss anything blocking
    await dismissModal(page)

    const settingsBtn = page.locator("[title='Settings'], button[aria-label*='settings' i]").first()
    if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await settingsBtn.click({ force: true })
      await page.waitForTimeout(1500)
      await page.screenshot({ path: `${SHOT}/09-quick-settings.png` })

      // ─── PHASE 7: FULL SETTINGS ──────────────────────────────────────
      console.log(`\n=== PHASE 7: FULL SETTINGS ===`)

      const allSettingsBtn = page.locator("button:has-text('All Settings'), text=All Settings").first()
      if (await allSettingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await allSettingsBtn.click()
        await page.waitForTimeout(1500)
        await page.screenshot({ path: `${SHOT}/10-full-settings.png` })

        // Navigate through each settings section
        const sections = [
          "General", "Session", "Models", "MCP Servers", "Slash Commands",
          "Constitution", "Global Directives", "Project Directives", "Active Rules",
          "Environment", "Accounts", "About",
        ]

        for (const section of sections) {
          const navItem = page.locator(`button:has-text("${section}"), [class*="cursor-pointer"]:has-text("${section}")`).first()
          if (await navItem.isVisible({ timeout: 500 }).catch(() => false)) {
            await navItem.click()
            await page.waitForTimeout(500)
            const safeName = section.toLowerCase().replace(/\s+/g, "-")
            await page.screenshot({ path: `${SHOT}/11-settings-${safeName}.png` })
          }
        }

        // Audit full settings visual hierarchy
        const settingsVisualAudit = await page.evaluate(() => {
          // Get all section headings and their styles
          const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6, [class*='heading'], [class*='title']")
          const headingStyles: string[] = []
          headings.forEach((h, i) => {
            if (i < 10) {
              const cs = getComputedStyle(h)
              const text = (h.textContent || "").trim().substring(0, 30)
              headingStyles.push(`"${text}": size=${cs.fontSize} weight=${cs.fontWeight} color=${cs.color}`)
            }
          })

          // Check card/panel consistency
          const panels = document.querySelectorAll("[class*='rounded'], [class*='border']")
          const panelBgs = new Set<string>()
          panels.forEach((p) => {
            const bg = getComputedStyle(p).backgroundColor
            if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
              panelBgs.add(bg)
            }
          })

          return {
            headingCount: headings.length,
            headingStyles,
            panelBgVariants: [...panelBgs].slice(0, 10),
          }
        })

        console.log(`Headings: ${settingsVisualAudit.headingCount}`)
        settingsVisualAudit.headingStyles.forEach((s) => console.log(`  ${s}`))
        console.log(`Panel bg variants: ${settingsVisualAudit.panelBgVariants.length}`)
        settingsVisualAudit.panelBgVariants.forEach((c) => console.log(`  ${c}`))
      }
    }

    // ─── PHASE 8: ACCESSIBILITY & CONTRAST ───────────────────────────
    console.log(`\n=== PHASE 8: ACCESSIBILITY & CONTRAST ===`)

    // Go back to a session view for the accessibility audit
    await page.keyboard.press("Escape")
    await page.waitForTimeout(1000)

    const contrastAudit = await page.evaluate(() => {
      function luminance(r: number, g: number, b: number) {
        const [rs, gs, bs] = [r, g, b].map((c) => {
          c /= 255
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
        })
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
      }

      function parseRgb(color: string): [number, number, number] | null {
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
        if (!match) return null
        return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])]
      }

      function contrastRatio(fg: string, bg: string): number | null {
        const fgRgb = parseRgb(fg)
        const bgRgb = parseRgb(bg)
        if (!fgRgb || !bgRgb) return null
        const l1 = luminance(...fgRgb)
        const l2 = luminance(...bgRgb)
        const lighter = Math.max(l1, l2)
        const darker = Math.min(l1, l2)
        return (lighter + 0.05) / (darker + 0.05)
      }

      const textElements = document.querySelectorAll("p, span, h1, h2, h3, h4, h5, h6, label, a, button, li, td, th")
      let lowContrastCount = 0
      const lowContrastSamples: string[] = []

      textElements.forEach((el) => {
        const cs = getComputedStyle(el)
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return
        const text = (el.textContent || "").trim()
        if (!text || text.length < 2) return

        // Walk up to find effective bg
        let bgColor = "rgba(0, 0, 0, 0)"
        let parent: Element | null = el as Element
        while (parent) {
          const pBg = getComputedStyle(parent).backgroundColor
          if (pBg !== "rgba(0, 0, 0, 0)" && pBg !== "transparent") {
            bgColor = pBg
            break
          }
          parent = parent.parentElement
        }

        const ratio = contrastRatio(cs.color, bgColor)
        if (ratio !== null && ratio < 3) {
          lowContrastCount++
          if (lowContrastSamples.length < 15) {
            lowContrastSamples.push(
              `"${text.substring(0, 40)}" ratio=${ratio.toFixed(2)} fg=${cs.color} bg=${bgColor}`,
            )
          }
        }
      })

      // Font distribution
      const fontSizes = new Map<string, number>()
      document.querySelectorAll("*").forEach((el) => {
        const fs = getComputedStyle(el).fontSize
        fontSizes.set(fs, (fontSizes.get(fs) || 0) + 1)
      })

      return {
        lowContrastCount,
        lowContrastSamples,
        fontSizeDistribution: [...fontSizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
      }
    })

    console.log(`Low contrast elements: ${contrastAudit.lowContrastCount}`)
    contrastAudit.lowContrastSamples.forEach((s) => console.log(`  ${s}`))
    console.log(`Font size distribution:`)
    contrastAudit.fontSizeDistribution.forEach(([size, count]) => console.log(`  ${size}: ${count} elements`))

    // ─── PHASE 9: TOKEN SURFACE AUDIT ────────────────────────────────
    console.log(`\n=== PHASE 9: TOKEN & SURFACE AUDIT ===`)

    const tokenAudit = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      const tokenNames = [
        "--background", "--foreground", "--card", "--card-foreground",
        "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
        "--accent", "--accent-foreground", "--border", "--input", "--ring",
        "--destructive", "--info", "--success", "--warning",
      ]
      const tokens: Record<string, string> = {}
      tokenNames.forEach((n) => {
        tokens[n] = root.getPropertyValue(n).trim()
      })

      // Check for invisible borders (border color same as bg)
      let invisibleBorders = 0
      let visibleBorders = 0
      document.querySelectorAll("*").forEach((el) => {
        const cs = getComputedStyle(el)
        if (parseFloat(cs.borderWidth) > 0 && cs.borderStyle !== "none") {
          if (cs.borderColor === cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") {
            invisibleBorders++
          } else {
            visibleBorders++
          }
        }
      })

      return { tokens, visibleBorders, invisibleBorders }
    })

    console.log("Design tokens:")
    Object.entries(tokenAudit.tokens).forEach(([k, v]) => console.log(`  ${k}: ${v}`))
    console.log(`Borders: ${tokenAudit.visibleBorders} visible, ${tokenAudit.invisibleBorders} invisible`)

    // Final state
    await page.screenshot({ path: `${SHOT}/99-final-state.png`, fullPage: true })
    console.log("\n=== AUDIT COMPLETE ===")
  })
})
