import { test, expect } from "@playwright/test"

const BASE = "http://localhost:3000"
const SCREENSHOT_DIR = "./tests/e2e/screenshots"

test.describe("Visual Inspection - UI Modernization", () => {
  test("capture full app in dark mode (default)", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(2000)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-app-dark-full.png`,
      fullPage: true,
    })
  })

  test("capture app at 1280px desktop width - dark", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(2000)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-app-dark-desktop.png`,
    })
  })

  test("capture app at 768px tablet width - dark", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(2000)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-app-dark-tablet.png`,
    })
  })

  test("capture app at 375px mobile width - dark", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(2000)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-app-dark-mobile.png`,
    })
  })

  test("switch to light mode and capture", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(2000)

    // Try to toggle theme - look for theme toggle button
    const themeToggle = page.locator('[aria-label*="theme" i], [aria-label*="Theme" i], [data-theme-toggle], button:has(svg[class*="sun"]), button:has(svg[class*="moon"])').first()
    if (await themeToggle.isVisible({ timeout: 3000 }).catch(() => false)) {
      await themeToggle.click()
      await page.waitForTimeout(1000)
    } else {
      // Force light mode via JS
      await page.evaluate(() => {
        document.documentElement.removeAttribute("data-theme")
      })
      await page.waitForTimeout(500)
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-app-light-full.png`,
      fullPage: true,
    })
  })

  test("capture light mode at 1280px desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(1000)
    await page.evaluate(() => {
      document.documentElement.removeAttribute("data-theme")
    })
    await page.waitForTimeout(1000)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-app-light-desktop.png`,
    })
  })

  test("inspect CSS custom properties", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(2000)

    // Check that new HSL tokens are being applied
    const tokenCheck = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      return {
        background: root.getPropertyValue("--background").trim(),
        foreground: root.getPropertyValue("--foreground").trim(),
        primary: root.getPropertyValue("--primary").trim(),
        border: root.getPropertyValue("--border").trim(),
        radius: root.getPropertyValue("--radius").trim(),
        // Legacy compat tokens (should be empty after token-compat.css deletion)
        surfaceBase: root.getPropertyValue("--surface-base").trim(),
        textPrimary: root.getPropertyValue("--text-primary").trim(),
        borderBase: root.getPropertyValue("--border-base").trim(),
        accentPrimary: root.getPropertyValue("--accent-primary").trim(),
        // Check font family
        fontFamily: root.getPropertyValue("--font-family-sans").trim(),
        // Check body computed styles
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        bodyFont: getComputedStyle(document.body).fontFamily,
      }
    })

    console.log("=== Token Inspection ===")
    console.log("New HSL tokens:")
    console.log(`  --background: "${tokenCheck.background}"`)
    console.log(`  --foreground: "${tokenCheck.foreground}"`)
    console.log(`  --primary: "${tokenCheck.primary}"`)
    console.log(`  --border: "${tokenCheck.border}"`)
    console.log(`  --radius: "${tokenCheck.radius}"`)
    console.log("\nLegacy compat tokens (should be empty):")
    console.log(`  --surface-base: "${tokenCheck.surfaceBase}"`)
    console.log(`  --text-primary: "${tokenCheck.textPrimary}"`)
    console.log(`  --border-base: "${tokenCheck.borderBase}"`)
    console.log(`  --accent-primary: "${tokenCheck.accentPrimary}"`)
    console.log("\nComputed body styles:")
    console.log(`  font-family: "${tokenCheck.fontFamily}"`)
    console.log(`  body bg: "${tokenCheck.bodyBg}"`)
    console.log(`  body color: "${tokenCheck.bodyColor}"`)
    console.log(`  body font: "${tokenCheck.bodyFont}"`)

    // Verify new tokens exist and aren't empty
    expect(tokenCheck.background).toBeTruthy()
    expect(tokenCheck.foreground).toBeTruthy()
    expect(tokenCheck.primary).toBeTruthy()
    expect(tokenCheck.radius).toBe("0.75rem")

    // Legacy compat tokens should be empty (token-compat.css was deleted in Phase 9)
    expect(tokenCheck.surfaceBase).toBe("")
    expect(tokenCheck.textPrimary).toBe("")
    expect(tokenCheck.borderBase).toBe("")
  })

  test("check no SUID artifacts in DOM", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(2000)

    const suidCheck = await page.evaluate(() => {
      const allElements = document.querySelectorAll("*")
      const muiClasses: string[] = []
      allElements.forEach((el) => {
        const classes = el.className
        if (typeof classes === "string" && classes.includes("Mui")) {
          muiClasses.push(`${el.tagName}: ${classes.substring(0, 100)}`)
        }
      })
      return {
        muiClassCount: muiClasses.length,
        muiSamples: muiClasses.slice(0, 10),
        hasCssBaseline: !!document.querySelector("[data-css-baseline]"),
      }
    })

    console.log("\n=== SUID Artifact Check ===")
    console.log(`MUI class elements found: ${suidCheck.muiClassCount}`)
    if (suidCheck.muiSamples.length > 0) {
      console.log("Samples:", suidCheck.muiSamples)
    }
    console.log(`CssBaseline element: ${suidCheck.hasCssBaseline}`)

    // These should be 0 after SUID removal
    expect(suidCheck.muiClassCount).toBe(0)
    expect(suidCheck.hasCssBaseline).toBe(false)
  })

  test("visual check: element rendering quality", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForTimeout(2000)

    const renderCheck = await page.evaluate(() => {
      const body = document.body
      const root = document.getElementById("root")
      const computedBody = getComputedStyle(body)
      const computedRoot = root ? getComputedStyle(root) : null

      // Check for visual issues
      const issues: string[] = []

      // Check body has proper background
      if (computedBody.backgroundColor === "rgba(0, 0, 0, 0)" || computedBody.backgroundColor === "transparent") {
        issues.push("Body has transparent background")
      }

      // Check body has proper text color
      if (computedBody.color === "rgb(0, 0, 0)" && document.documentElement.getAttribute("data-theme") === "dark") {
        issues.push("Dark mode body has black text (should be light)")
      }

      // Check for font loading
      const fontLoaded = computedBody.fontFamily.includes("Inter") || computedBody.fontFamily.includes("Figtree")
      if (!fontLoaded) {
        issues.push(`Font not applied correctly: ${computedBody.fontFamily}`)
      }

      // Check for overflow issues
      if (body.scrollWidth > window.innerWidth + 5) {
        issues.push(`Horizontal overflow: body width ${body.scrollWidth} > viewport ${window.innerWidth}`)
      }

      // Check root fills viewport
      if (computedRoot && computedRoot.height === "0px") {
        issues.push("Root element has 0 height")
      }

      // Check for any elements with broken backgrounds (transparent where shouldn't be)
      const header = document.querySelector("header")
      if (header) {
        const headerBg = getComputedStyle(header).backgroundColor
        if (headerBg === "rgba(0, 0, 0, 0)") {
          issues.push("Header has transparent background (may be rendering issue)")
        }
      }

      return {
        issues,
        bodyBg: computedBody.backgroundColor,
        bodyColor: computedBody.color,
        bodyFont: computedBody.fontFamily,
        rootHeight: computedRoot?.height ?? "N/A",
        rootWidth: computedRoot?.width ?? "N/A",
        theme: document.documentElement.getAttribute("data-theme"),
        hasHeader: !!header,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }
    })

    console.log("\n=== Render Quality Check ===")
    console.log(`Theme: ${renderCheck.theme}`)
    console.log(`Body bg: ${renderCheck.bodyBg}`)
    console.log(`Body color: ${renderCheck.bodyColor}`)
    console.log(`Body font: ${renderCheck.bodyFont}`)
    console.log(`Root size: ${renderCheck.rootWidth} x ${renderCheck.rootHeight}`)
    console.log(`Has header: ${renderCheck.hasHeader}`)
    console.log(`Viewport: ${renderCheck.viewportWidth}x${renderCheck.viewportHeight}`)

    if (renderCheck.issues.length > 0) {
      console.log("\n⚠ Issues found:")
      renderCheck.issues.forEach((i) => console.log(`  - ${i}`))
    } else {
      console.log("\n✓ No rendering issues detected")
    }
  })
})
