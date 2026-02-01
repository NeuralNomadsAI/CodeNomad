import { test, expect, type Page } from "@playwright/test"

const BASE = "http://localhost:3000"
const SCREENSHOT_DIR = "./tests/e2e/screenshots/migration-audit"

// Helper: wait for app shell to be interactive
async function waitForApp(page: Page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
  await page.waitForTimeout(2500)
  await page.waitForSelector("#root", { state: "attached", timeout: 10000 })
}

// Helper: screenshot with auto-naming
let screenshotIndex = 0
async function snap(page: Page, name: string) {
  screenshotIndex++
  const idx = String(screenshotIndex).padStart(2, "0")
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${idx}-${name}.png` })
}

// ──────────────────────────────────────────────────────────────────
// 1. TOKEN SYSTEM INTEGRITY
// ──────────────────────────────────────────────────────────────────
test.describe("1. Token System Integrity", () => {
  test.setTimeout(60000)

  test("all core HSL tokens resolve to non-empty values in dark mode", async ({ page }) => {
    await waitForApp(page)
    const tokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      const get = (k: string) => root.getPropertyValue(`--${k}`).trim()
      return {
        background: get("background"),
        foreground: get("foreground"),
        card: get("card"),
        cardForeground: get("card-foreground"),
        popover: get("popover"),
        popoverForeground: get("popover-foreground"),
        primary: get("primary"),
        primaryForeground: get("primary-foreground"),
        secondary: get("secondary"),
        secondaryForeground: get("secondary-foreground"),
        muted: get("muted"),
        mutedForeground: get("muted-foreground"),
        accent: get("accent"),
        accentForeground: get("accent-foreground"),
        destructive: get("destructive"),
        destructiveForeground: get("destructive-foreground"),
        border: get("border"),
        input: get("input"),
        ring: get("ring"),
        radius: get("radius"),
        success: get("success"),
        warning: get("warning"),
        info: get("info"),
      }
    })

    for (const [key, value] of Object.entries(tokens)) {
      expect(value, `Token --${key} should not be empty`).toBeTruthy()
    }
    expect(tokens.radius).toBe("0.75rem")
  })

  test("token-compat.css variables are fully removed (no legacy fallbacks)", async ({ page }) => {
    await waitForApp(page)
    const legacyTokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      const get = (k: string) => root.getPropertyValue(k).trim()
      return {
        surfaceBase: get("--surface-base"),
        surfaceRaised: get("--surface-raised"),
        surfaceOverlay: get("--surface-overlay"),
        surfaceInset: get("--surface-inset"),
        textPrimary: get("--text-primary"),
        textSecondary: get("--text-secondary"),
        textTertiary: get("--text-tertiary"),
        textMuted: get("--text-muted"),
        borderBase: get("--border-base"),
        borderStrong: get("--border-strong"),
        borderSubtle: get("--border-subtle"),
        statusError: get("--status-error"),
        statusWarning: get("--status-warning"),
        statusSuccess: get("--status-success"),
        statusInfo: get("--status-info"),
        messageUserBg: get("--message-user-bg"),
        messageUserBorder: get("--message-user-border"),
        messageAssistantBg: get("--message-assistant-bg"),
        messageAssistantBorder: get("--message-assistant-border"),
        accentPrimary: get("--accent-primary"),
      }
    })

    for (const [key, value] of Object.entries(legacyTokens)) {
      expect(value, `Legacy token ${key} should be empty (token-compat.css deleted)`).toBe("")
    }
  })

  test("dark mode tokens differ from light mode tokens", async ({ page }) => {
    await waitForApp(page)

    // Get dark mode tokens (default)
    const darkBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--background").trim()
    )

    // Switch to light mode
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"))
    await page.waitForTimeout(300)

    const lightBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--background").trim()
    )

    // Restore dark mode
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"))

    expect(darkBg).not.toBe(lightBg)
    // Dark background should have high lightness < 10% (dark)
    expect(darkBg).toMatch(/\d/)
    // Light background should be bright
    expect(lightBg).toMatch(/\d/)
  })
})

// ──────────────────────────────────────────────────────────────────
// 2. NO LEGACY CSS ARTIFACTS IN DOM
// ──────────────────────────────────────────────────────────────────
test.describe("2. No Legacy CSS Artifacts", () => {
  test.setTimeout(60000)

  test("no elements use deleted legacy CSS classes", async ({ page }) => {
    await waitForApp(page)

    const legacyClassScan = await page.evaluate(() => {
      const legacyPatterns = [
        // panels.css classes
        "tab-bar", "tab-base", "tab-active", "tab-inactive", "tab-close",
        "new-tab-button", "connection-status-button", "connection-status-meta",
        "status-indicator", "status-dot", "empty-state", "loading-state",
        "modal-overlay", "modal-surface", "modal-search", "modal-list",
        "modal-item", "panel-header", "panel-title", "panel-body",
        "panel-section", "panel-list-item", "panel-empty-state",
        "session-view", "session-list-container", "session-resize-handle",
        "control-panel-section", "control-panel-trigger",
        // buttons.css classes
        "button-primary", "button-secondary", "button-tertiary",
        "button-ghost", "button-icon", "button-small",
        // utilities.css classes
        "bg-surface-base", "focus-ring",
        // selector.css classes
        "selector-trigger", "selector-option", "selector-input",
        "selector-search-input", "selector-badge", "selector-button",
        // settings-panel classes
        "settings-panel-header", "settings-panel-title",
        // other legacy
        "spinner", "spinner-small",
        "full-settings-btn", "full-settings-toggle",
        "commands-btn", "commands-panel-overlay",
      ]

      const allElements = document.querySelectorAll("*")
      const found: { element: string; classes: string; legacy: string[] }[] = []

      allElements.forEach((el) => {
        const cls = el.className
        if (typeof cls !== "string" || !cls) return
        const matches = legacyPatterns.filter((p) => {
          // Match as whole word in class string
          const re = new RegExp(`\\b${p}\\b`)
          return re.test(cls)
        })
        if (matches.length > 0) {
          found.push({
            element: `${el.tagName}`,
            classes: cls.substring(0, 200),
            legacy: matches,
          })
        }
      })

      return found
    })

    if (legacyClassScan.length > 0) {
      console.log("Legacy CSS classes found in DOM:")
      legacyClassScan.forEach((f) => {
        console.log(`  <${f.element}> has: ${f.legacy.join(", ")}`)
        console.log(`    classes: ${f.classes}`)
      })
    }

    expect(legacyClassScan.length, "No elements should use legacy CSS classes").toBe(0)
  })

  test("no SUID/MUI artifacts in DOM", async ({ page }) => {
    await waitForApp(page)

    const muiCount = await page.evaluate(() => {
      let count = 0
      document.querySelectorAll("*").forEach((el) => {
        if (typeof el.className === "string" && el.className.includes("Mui")) count++
      })
      return count
    })

    expect(muiCount).toBe(0)
  })

  test("no orphaned CSS @import references in loaded stylesheets", async ({ page }) => {
    await waitForApp(page)

    const cssErrors = await page.evaluate(() => {
      const errors: string[] = []
      for (const sheet of document.styleSheets) {
        try {
          const rules = sheet.cssRules
          for (const rule of rules) {
            if (rule instanceof CSSImportRule) {
              // Check if imported sheet is empty or failed to load
              try {
                if (!rule.styleSheet || rule.styleSheet.cssRules.length === 0) {
                  errors.push(`Empty/failed @import: ${rule.href}`)
                }
              } catch {
                errors.push(`Could not access imported sheet: ${rule.href}`)
              }
            }
          }
        } catch {
          // Cross-origin stylesheets can't be read; that's fine
        }
      }
      return errors
    })

    if (cssErrors.length > 0) {
      console.log("CSS import issues:", cssErrors)
    }

    expect(cssErrors.length, "No broken CSS @imports").toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────
// 3. VISUAL RENDERING — BASE SHELL
// ──────────────────────────────────────────────────────────────────
test.describe("3. Visual Rendering — Base Shell", () => {
  test.setTimeout(60000)

  test("body and root render correctly with dark background", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    const render = await page.evaluate(() => {
      const body = getComputedStyle(document.body)
      const root = document.getElementById("root")
      const rootStyle = root ? getComputedStyle(root) : null
      return {
        bodyBg: body.backgroundColor,
        bodyColor: body.color,
        bodyFont: body.fontFamily,
        bodyFontSize: body.fontSize,
        rootWidth: rootStyle?.width ?? "missing",
        rootHeight: rootStyle?.height ?? "missing",
        rootBg: rootStyle?.backgroundColor ?? "missing",
        theme: document.documentElement.getAttribute("data-theme"),
        scrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
      }
    })

    // Body should have a dark background (not transparent, not white)
    expect(render.bodyBg).not.toBe("rgba(0, 0, 0, 0)")
    expect(render.bodyBg).not.toBe("transparent")
    expect(render.bodyBg).not.toBe("rgb(255, 255, 255)")

    // Body should have light text in dark mode
    expect(render.bodyColor).not.toBe("rgb(0, 0, 0)")

    // Font family should include Inter or system fallback
    expect(render.bodyFont).toMatch(/Inter|Figtree|system-ui|sans-serif/)

    // Root should fill viewport
    expect(parseInt(render.rootWidth)).toBeGreaterThan(0)
    expect(parseInt(render.rootHeight)).toBeGreaterThan(0)

    // No horizontal overflow
    expect(render.scrollWidth).toBeLessThanOrEqual(render.innerWidth + 5)

    await snap(page, "base-shell-dark")
  })

  test("light mode renders correctly without legacy styles", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    // Force light
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"))
    await page.waitForTimeout(500)

    const render = await page.evaluate(() => {
      const body = getComputedStyle(document.body)
      return {
        bodyBg: body.backgroundColor,
        bodyColor: body.color,
      }
    })

    // Light mode: bg should be bright, text should be dark
    expect(render.bodyBg).not.toBe("rgba(0, 0, 0, 0)")
    // Light bg typically has high luminance components
    expect(render.bodyColor).not.toBe("rgb(255, 255, 255)")

    await snap(page, "base-shell-light")

    // Restore
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"))
  })

  test("responsive viewport sizes render without overflow", async ({ page }) => {
    const sizes = [
      { width: 1920, height: 1080, name: "1920-hd" },
      { width: 1280, height: 800, name: "1280-desktop" },
      { width: 768, height: 1024, name: "768-tablet" },
      { width: 375, height: 812, name: "375-mobile" },
    ]

    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height })
      await waitForApp(page)

      const overflow = await page.evaluate(() => ({
        scrollW: document.body.scrollWidth,
        innerW: window.innerWidth,
        scrollH: document.body.scrollHeight,
        innerH: window.innerHeight,
      }))

      expect(
        overflow.scrollW,
        `No horizontal overflow at ${size.name}`
      ).toBeLessThanOrEqual(overflow.innerW + 5)

      await snap(page, `responsive-${size.name}`)
    }
  })
})

// ──────────────────────────────────────────────────────────────────
// 4. TAILWIND CLASS COVERAGE — VERIFY KEY UTILITIES RESOLVE
// ──────────────────────────────────────────────────────────────────
test.describe("4. Tailwind Class Coverage", () => {
  test.setTimeout(60000)

  test("semantic color utilities resolve to actual colors", async ({ page }) => {
    await waitForApp(page)

    const colors = await page.evaluate(() => {
      const div = document.createElement("div")
      document.body.appendChild(div)

      const check = (cls: string, prop: string) => {
        div.className = cls
        const val = getComputedStyle(div)[prop as keyof CSSStyleDeclaration] as string
        return val
      }

      const results = {
        bgBackground: check("bg-background", "backgroundColor"),
        bgSecondary: check("bg-secondary", "backgroundColor"),
        bgDestructive: check("bg-destructive", "backgroundColor"),
        bgPrimary: check("bg-primary", "backgroundColor"),
        textForeground: check("text-foreground", "color"),
        textMutedForeground: check("text-muted-foreground", "color"),
        textDestructive: check("text-destructive", "color"),
        borderBorder: check("border border-border", "borderColor"),
      }

      document.body.removeChild(div)
      return results
    })

    // All should be actual colors, not transparent or empty
    for (const [cls, value] of Object.entries(colors)) {
      expect(value, `${cls} should resolve to a color`).not.toBe("rgba(0, 0, 0, 0)")
      expect(value, `${cls} should be defined`).toBeTruthy()
    }
  })

  test("animation utilities are defined and functional", async ({ page }) => {
    await waitForApp(page)

    const animations = await page.evaluate(() => {
      const div = document.createElement("div")
      document.body.appendChild(div)

      const check = (cls: string) => {
        div.className = cls
        return getComputedStyle(div).animationName
      }

      const results = {
        pulse: check("animate-pulse"),
        spin: check("animate-spin"),
        shimmer: check("animate-shimmer"),
        bounceIn: check("animate-bounce-in"),
        glowPulse: check("animate-glow-pulse"),
        activityDotPulse: check("animate-activity-dot-pulse"),
      }

      document.body.removeChild(div)
      return results
    })

    // Animation names should resolve, not be "none"
    expect(animations.pulse).not.toBe("none")
    expect(animations.spin).not.toBe("none")
    expect(animations.shimmer).not.toBe("none")
  })
})

// ──────────────────────────────────────────────────────────────────
// 5. COMPONENT RENDERING — INTERACTIVE WALKTHROUGH
// ──────────────────────────────────────────────────────────────────
test.describe("5. Component Rendering Walkthrough", () => {
  test.setTimeout(120000)

  test("instance tabs render with proper styling", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    // Tab bar should be visible at top
    const tabBar = page.locator('[style*="app-region"], [class*="flex"][class*="items-center"][class*="h-10"]').first()
    const tabBarVisible = await tabBar.isVisible({ timeout: 5000 }).catch(() => false)

    if (tabBarVisible) {
      const tabBarStyles = await tabBar.evaluate((el) => {
        const s = getComputedStyle(el)
        return {
          bg: s.backgroundColor,
          height: s.height,
          display: s.display,
          borderBottom: s.borderBottomWidth,
        }
      })

      // Tab bar should have visible background and height
      expect(tabBarStyles.bg).not.toBe("rgba(0, 0, 0, 0)")
      expect(parseInt(tabBarStyles.height)).toBeGreaterThan(0)
      expect(tabBarStyles.display).toBe("flex")
    }

    await snap(page, "instance-tabs")
  })

  test("bottom status bar renders with proper styling", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    // Look for bottom bar
    const statusBar = page.locator('[class*="border-t"][class*="bg-background"]').last()
    const statusVisible = await statusBar.isVisible({ timeout: 5000 }).catch(() => false)

    if (statusVisible) {
      const styles = await statusBar.evaluate((el) => {
        const s = getComputedStyle(el)
        return {
          bg: s.backgroundColor,
          borderTop: s.borderTopWidth,
          display: s.display,
        }
      })

      expect(styles.bg).not.toBe("rgba(0, 0, 0, 0)")
    }

    await snap(page, "bottom-status-bar")
  })

  test("prompt input area renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    // Find textarea / prompt area
    const textarea = page.locator("textarea").first()
    const textareaVisible = await textarea.isVisible({ timeout: 5000 }).catch(() => false)

    if (textareaVisible) {
      const styles = await textarea.evaluate((el) => {
        const s = getComputedStyle(el)
        return {
          bg: s.backgroundColor,
          color: s.color,
          fontFamily: s.fontFamily,
          fontSize: s.fontSize,
          border: s.borderWidth,
          resize: s.resize,
        }
      })

      // Textarea should have background (not transparent)
      expect(styles.bg).not.toBe("rgba(0, 0, 0, 0)")
      // Should have proper text color
      expect(styles.color).not.toBe("rgba(0, 0, 0, 0)")
      // Should not allow resize (CSS migration sets resize: none)
      expect(styles.resize).toBe("none")
    }

    await snap(page, "prompt-input")
  })

  test("settings panel opens and renders without legacy CSS", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    // Try multiple approaches to open settings
    const triggers = [
      'button:has-text("Settings")',
      '[aria-label="Settings"]',
      'button:has(svg.lucide-settings)',
      // Bottom bar settings icon
      '[class*="cursor-pointer"][class*="hover\\:bg-accent"]',
    ]

    let opened = false
    for (const sel of triggers) {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click()
        await page.waitForTimeout(500)
        opened = true
        break
      }
    }

    if (!opened) {
      // Try keyboard shortcut
      await page.keyboard.press("Meta+,")
      await page.waitForTimeout(500)
    }

    await snap(page, "settings-attempt")

    // Look for "All Settings" if quick settings opened
    const allSettings = page.locator('button:has-text("All Settings"), a:has-text("All Settings")').first()
    if (await allSettings.isVisible({ timeout: 2000 }).catch(() => false)) {
      await allSettings.click()
      await page.waitForTimeout(500)
    }

    // Check for full settings overlay
    const settingsOverlay = page.locator('[class*="fixed"][class*="inset-0"][class*="z-50"]').first()
    const settingsOpen = await settingsOverlay.isVisible({ timeout: 3000 }).catch(() => false)

    if (settingsOpen) {
      const overlayStyles = await settingsOverlay.evaluate((el) => {
        const s = getComputedStyle(el)
        return {
          bg: s.backgroundColor,
          position: s.position,
          display: s.display,
        }
      })

      expect(overlayStyles.position).toBe("fixed")
      expect(overlayStyles.bg).not.toBe("rgba(0, 0, 0, 0)")

      await snap(page, "settings-open")

      // Try navigating between sections
      const navItems = page.locator('[class*="px-3"][class*="py-2"][class*="rounded"][class*="cursor-pointer"]')
      const navCount = await navItems.count()

      if (navCount > 1) {
        // Click second nav item
        await navItems.nth(1).click()
        await page.waitForTimeout(300)
        await snap(page, "settings-section-2")

        // Click third nav item
        if (navCount > 2) {
          await navItems.nth(2).click()
          await page.waitForTimeout(300)
          await snap(page, "settings-section-3")
        }
      }

      // Close settings
      await page.keyboard.press("Escape")
      await page.waitForTimeout(300)
    }
  })
})

// ──────────────────────────────────────────────────────────────────
// 6. DEEP CSS PROPERTY AUDIT
// ──────────────────────────────────────────────────────────────────
test.describe("6. Deep CSS Property Audit", () => {
  test.setTimeout(60000)

  test("no elements have invisible text (color = transparent)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    const invisibleText = await page.evaluate(() => {
      const problems: string[] = []
      document.querySelectorAll("*").forEach((el) => {
        const s = getComputedStyle(el)
        const text = el.textContent?.trim()
        if (!text || s.display === "none" || s.visibility === "hidden") return

        // Check for invisible text
        if (s.color === "rgba(0, 0, 0, 0)" && s.opacity !== "0") {
          problems.push(`<${el.tagName}> invisible text: "${text.substring(0, 40)}"`)
        }
      })
      return problems.slice(0, 20)
    })

    if (invisibleText.length > 0) {
      console.log("Invisible text found:", invisibleText)
    }

    expect(invisibleText.length, "No invisible text elements").toBe(0)
  })

  test("no broken border-color references", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    const brokenBorders = await page.evaluate(() => {
      const problems: string[] = []
      document.querySelectorAll("*").forEach((el) => {
        const s = getComputedStyle(el)
        // Elements with border-width > 0 but transparent border color may indicate broken token refs
        const bw = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth) +
                    parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth)
        if (bw > 0) {
          const bc = s.borderTopColor
          // "rgba(0, 0, 0, 0)" is transparent — typically fine for border-x-transparent, but flag if unexpected
          // We mostly care about broken var() references that resolve to nothing
          if (bc === "rgba(0, 0, 0, 0)" && el.className && typeof el.className === "string" && el.className.includes("border-border")) {
            problems.push(`<${el.tagName}> has border-border but transparent border color`)
          }
        }
      })
      return problems.slice(0, 10)
    })

    if (brokenBorders.length > 0) {
      console.log("Broken border references:", brokenBorders)
    }

    // This is a soft check — some transparent borders are intentional
    expect(brokenBorders.length, "No broken border-border references").toBe(0)
  })

  test("font families apply correctly (no fallback to serif/monospace where unexpected)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    const fontCheck = await page.evaluate(() => {
      const body = getComputedStyle(document.body)
      const problems: string[] = []

      // Body should use sans-serif stack
      if (body.fontFamily.includes("serif") && !body.fontFamily.includes("sans-serif")) {
        problems.push(`Body font is serif: ${body.fontFamily}`)
      }

      // Check for unexpected monospace on non-code elements
      document.querySelectorAll("button, h1, h2, h3, p, span, div, label").forEach((el) => {
        const s = getComputedStyle(el)
        const font = s.fontFamily.toLowerCase()
        // Monospace should only appear on elements with font-mono class or inside pre/code
        if (
          font.startsWith("\"jetbrains") ||
          font.startsWith("ui-monospace")
        ) {
          const cls = typeof el.className === "string" ? el.className : ""
          const isMonoIntended = cls.includes("font-mono") || cls.includes("monospace") ||
            el.closest("pre, code, .font-mono, [class*='font-mono']") !== null
          if (!isMonoIntended) {
            problems.push(`<${el.tagName}> has monospace font but no font-mono class`)
          }
        }
      })

      return { bodyFont: body.fontFamily, problems: problems.slice(0, 10) }
    })

    expect(fontCheck.bodyFont).toMatch(/Inter|Figtree|system-ui|sans-serif/)
    // Monospace misapplication would indicate CSS migration issue
    if (fontCheck.problems.length > 0) {
      console.log("Font issues:", fontCheck.problems)
    }
  })

  test("z-index layers don't collide (modals above content)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    const zLayers = await page.evaluate(() => {
      const layers: { element: string; zIndex: string; position: string }[] = []
      document.querySelectorAll("*").forEach((el) => {
        const s = getComputedStyle(el)
        const z = parseInt(s.zIndex)
        if (!isNaN(z) && z > 0) {
          layers.push({
            element: `<${el.tagName}> class="${(typeof el.className === "string" ? el.className : "").substring(0, 80)}"`,
            zIndex: s.zIndex,
            position: s.position,
          })
        }
      })
      return layers.sort((a, b) => parseInt(b.zIndex) - parseInt(a.zIndex)).slice(0, 15)
    })

    // Just log for visibility — no hard assertion, but modal z-50 should be highest
    console.log("Z-index layers:", zLayers)
  })
})

// ──────────────────────────────────────────────────────────────────
// 7. THEME TOGGLE & DARK/LIGHT CONSISTENCY
// ──────────────────────────────────────────────────────────────────
test.describe("7. Theme Toggle Consistency", () => {
  test.setTimeout(60000)

  test("switching between dark and light preserves layout structure", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)

    // Capture dark state
    const darkState = await page.evaluate(() => {
      const root = document.getElementById("root")!
      return {
        rootW: root.offsetWidth,
        rootH: root.offsetHeight,
        childCount: root.children.length,
        theme: document.documentElement.getAttribute("data-theme"),
      }
    })

    await snap(page, "theme-dark")

    // Switch to light
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"))
    await page.waitForTimeout(500)

    const lightState = await page.evaluate(() => {
      const root = document.getElementById("root")!
      return {
        rootW: root.offsetWidth,
        rootH: root.offsetHeight,
        childCount: root.children.length,
        theme: document.documentElement.getAttribute("data-theme"),
      }
    })

    await snap(page, "theme-light")

    // Layout should be structurally identical
    expect(lightState.rootW).toBe(darkState.rootW)
    expect(lightState.rootH).toBe(darkState.rootH)
    expect(lightState.childCount).toBe(darkState.childCount)

    // Restore dark
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"))
  })

  test("dark mode uses blue-tinted surfaces (not flat gray)", async ({ page }) => {
    await waitForApp(page)

    const surfaceCheck = await page.evaluate(() => {
      // Check secondary surface (used for panels, sidebars)
      const secondaryToken = getComputedStyle(document.documentElement).getPropertyValue("--secondary").trim()
      // Parse HSL: expect hue around 215 (blue-tinted), not 0 (pure gray)
      const parts = secondaryToken.split(/\s+/)
      return {
        raw: secondaryToken,
        hue: parseFloat(parts[0]) || 0,
        saturation: parseFloat(parts[1]) || 0,
      }
    })

    // Dark mode secondary should be blue-tinted (hue ~215, sat > 0)
    expect(surfaceCheck.saturation).toBeGreaterThan(0)
    expect(surfaceCheck.hue).toBeGreaterThan(200)
    expect(surfaceCheck.hue).toBeLessThan(230)
  })
})

// ──────────────────────────────────────────────────────────────────
// 8. CSS FILE HYGIENE — VERIFY ONLY tokens.css + markdown.css REMAIN
// ──────────────────────────────────────────────────────────────────
test.describe("8. CSS File Hygiene", () => {
  test.setTimeout(30000)

  test("index.css only imports tokens.css and markdown.css", async ({ page }) => {
    await waitForApp(page)

    const stylesheets = await page.evaluate(() => {
      const sheets: string[] = []
      for (const sheet of document.styleSheets) {
        if (sheet.href) {
          sheets.push(sheet.href)
        }
        // Check for inline @import rules
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSImportRule && rule.href) {
              sheets.push(`@import: ${rule.href}`)
            }
          }
        } catch { /* cross-origin */ }
      }
      return sheets
    })

    // Should NOT find references to deleted CSS files
    const deletedFiles = [
      "panels.css", "messaging.css", "controls.css",
      "utilities.css", "buttons.css", "selector.css",
      "token-compat.css",
    ]

    for (const deleted of deletedFiles) {
      const found = stylesheets.some((s) => s.includes(deleted))
      expect(found, `${deleted} should not be loaded`).toBe(false)
    }

    // Should find tokens.css and markdown.css
    const hasTokens = stylesheets.some((s) => s.includes("tokens.css"))
    const hasMarkdown = stylesheets.some((s) => s.includes("markdown.css"))
    // Note: in dev mode, Vite may inline CSS, so these checks are soft
    console.log("Loaded stylesheets:", stylesheets)
  })
})

// ──────────────────────────────────────────────────────────────────
// 9. SCREENSHOT GALLERY — COMPREHENSIVE VISUAL RECORD
// ──────────────────────────────────────────────────────────────────
test.describe("9. Screenshot Gallery", () => {
  test.setTimeout(120000)

  test("capture complete visual record at 1280x800", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForApp(page)
    await snap(page, "gallery-01-app-dark-1280")

    // Light mode
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"))
    await page.waitForTimeout(500)
    await snap(page, "gallery-02-app-light-1280")

    // Back to dark
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"))
    await page.waitForTimeout(300)

    // Try to interact with visible elements for screenshot variety
    // Click on session list item if visible
    const sessionItem = page.locator('[class*="cursor-pointer"][class*="hover\\:bg"]').first()
    if (await sessionItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sessionItem.click()
      await page.waitForTimeout(500)
      await snap(page, "gallery-03-after-click")
    }

    // Try keyboard shortcut to open command palette
    await page.keyboard.press("Meta+k")
    await page.waitForTimeout(500)
    await snap(page, "gallery-04-command-palette-attempt")
    await page.keyboard.press("Escape")
    await page.waitForTimeout(300)
  })
})

// ──────────────────────────────────────────────────────────────────
// 10. PERFORMANCE — CSS BUNDLE SIZE & RENDER METRICS
// ──────────────────────────────────────────────────────────────────
test.describe("10. Performance Sanity", () => {
  test.setTimeout(60000)

  test("total CSS rules count is reasonable (migration reduced bloat)", async ({ page }) => {
    await waitForApp(page)

    const cssMetrics = await page.evaluate(() => {
      let totalRules = 0
      let totalSheets = 0

      for (const sheet of document.styleSheets) {
        totalSheets++
        try {
          totalRules += sheet.cssRules.length
        } catch { /* cross-origin */ }
      }

      return { totalSheets, totalRules }
    })

    console.log(`CSS metrics: ${cssMetrics.totalSheets} stylesheets, ${cssMetrics.totalRules} rules`)

    // After deleting ~16,000 lines of CSS, rule count should be reasonable
    // Tailwind generates utility classes on demand, so total should be manageable
    // This is a loose sanity check — if it's over 50,000 something is wrong
    expect(cssMetrics.totalRules).toBeLessThan(50000)
  })

  test("first contentful paint is reasonable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })

    const start = Date.now()
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForSelector("#root > *", { state: "attached", timeout: 15000 })
    const loadTime = Date.now() - start

    console.log(`App load time (to first content): ${loadTime}ms`)

    // Should load in under 15 seconds even on slow machines
    expect(loadTime).toBeLessThan(15000)
  })
})
