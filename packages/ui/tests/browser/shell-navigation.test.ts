import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({
      configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
      cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "shell-navigation-fixture", configureServer(s) {
        s.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/fixture", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/header-windows.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] },
      optimizeDeps: { entries: ["tests/browser/fixtures/header-windows.tsx"], exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
}, { timeout: 60000 })
after(async () => { try { await browser?.close() } finally { await server?.close() } })

async function open(context: BrowserContext) {
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { page, errors }
}

const toggle = (page: Page, side: "left" | "right") => page.locator(`.shell-panel-toggle--${side} button`)
const box = async (page: Page, side: "left" | "right") => {
  const rect = (await toggle(page, side).boundingBox())!
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
}
const drawers = (page: Page) => page.evaluate(() => ({
  left: document.querySelector(".session-sidebar-container") ? "pinned"
    : document.querySelector(".session-floating-drawer .session-sidebar-header") ? "floating" : "closed",
  right: document.querySelector(".session-right-panel") ? "pinned"
    : document.querySelector(".session-floating-drawer .right-panel-tab-bar") ? "floating" : "closed",
}))
const waitDrawers = (page: Page, left: string, right: string) => page.waitForFunction(({ left, right }) => {
  const leftState = document.querySelector(".session-sidebar-container") ? "pinned"
    : document.querySelector(".session-floating-drawer .session-sidebar-header") ? "floating" : "closed"
  const rightState = document.querySelector(".session-right-panel") ? "pinned"
    : document.querySelector(".session-floating-drawer .right-panel-tab-bar") ? "floating" : "closed"
  // Floating papers must also finish sliding before geometry is compared.
  const settled = [...document.querySelectorAll(".session-floating-drawer .MuiDrawer-paper")]
    .every(paper => getComputedStyle(paper).transform === "none")
  return leftState === left && rightState === right && settled
}, { left, right })

/** Every visible header control must lie clear of both fixed toggles. */
const overlaps = (page: Page) => page.evaluate(() => {
  const toggles = [...document.querySelectorAll(".shell-panel-toggle button")].map(el => el.getBoundingClientRect())
  const candidates = [...document.querySelectorAll(".session-sidebar-header button, .right-panel-tab-bar button, .right-panel-tab-bar [role=tab], .session-toolbar button, .session-toolbar .context-meter")]
    .filter(el => {
      const rect = el.getBoundingClientRect()
      if (!rect.width || el.closest("[aria-hidden=true]")) return false
      // Covered conversation chrome under a floating drawer is not interactive.
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return hit !== null && (el.contains(hit) || hit.contains(el))
    })
  return candidates.flatMap(el => {
    const rect = el.getBoundingClientRect()
    return toggles.some(t => rect.left < t.right && t.left < rect.right && rect.top < t.bottom && t.top < rect.bottom)
      ? [el.getAttribute("aria-label") ?? el.textContent ?? el.className] : []
  })
})
const hiddenAncestors = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".shell-panel-toggle")].flatMap(el => {
  const hidden: string[] = []
  for (let node: Element | null = el; node; node = node.parentElement) if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("inert")) hidden.push(node.className)
  return hidden
}))

test("docked panels toggle from fixed buttons that never move", async () => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const { page, errors } = await open(context)
  try {
    await waitDrawers(page, "pinned", "pinned")
    const left = await box(page, "left"), right = await box(page, "right")
    // Both toggles hug the window edges (--space-xs).
    assert.equal(left.x, 4)
    assert.equal(1600 - (right.x + right.width), 4)
    assert.equal(await toggle(page, "left").getAttribute("aria-expanded"), "true")
    assert.equal(await toggle(page, "left").getAttribute("aria-label"), "Close left drawer")
    assert.equal(await toggle(page, "left").getAttribute("aria-controls"), "session-sidebar-header-windows")
    assert.equal(await page.locator("#session-sidebar-header-windows").count(), 1)
    assert.equal(await page.locator("#session-right-panel-header-windows").count(), 1)
    assert.deepEqual(await overlaps(page), [])

    // Open panels share the exact active treatment of the header's search toggle.
    const search = page.getByRole("button", { name: "Search chat history", exact: true })
    await search.click()
    await page.mouse.move(700, 600)
    await page.waitForFunction(() => document.querySelector('button[aria-label="Search chat history"]')?.getAttribute("aria-expanded") === "true")
    // MUI transitions the background for 150 ms; compare settled colours only.
    await page.waitForTimeout(500)
    const activeStyle = (selector: string) => page.locator(selector).evaluate(el => {
      const style = getComputedStyle(el)
      return { className: el.className.replace(/\s*css-\S+/g, ""), background: style.backgroundColor, color: style.color, opacity: style.opacity }
    })
    const searchActive = await activeStyle('button[aria-label="Search chat history"]')
    assert.notEqual(searchActive.background, "rgba(0, 0, 0, 0)")
    assert.deepEqual(await activeStyle(".shell-panel-toggle--left button"), searchActive)
    assert.deepEqual(await activeStyle(".shell-panel-toggle--right button"), searchActive)
    await search.click()

    await toggle(page, "left").click()
    await waitDrawers(page, "closed", "pinned")
    assert.equal(await toggle(page, "left").getAttribute("aria-expanded"), "false")
    assert.equal(await toggle(page, "left").getAttribute("aria-label"), "Open left drawer")
    await toggle(page, "right").click()
    await waitDrawers(page, "closed", "closed")
    assert.deepEqual(await box(page, "left"), left)
    assert.deepEqual(await box(page, "right"), right)
    assert.deepEqual(await overlaps(page), [])
    // Panel open/close no longer uses arrow glyphs anywhere in the chrome.
    assert.equal(await page.locator(".session-toolbar svg.lucide-arrow-right, .session-toolbar svg.lucide-arrow-left, .right-panel-tab-bar svg.lucide-arrow-right").count(), 0)

    await toggle(page, "left").click()
    await toggle(page, "right").click()
    await waitDrawers(page, "pinned", "pinned")
    assert.deepEqual(await box(page, "left"), left)
    assert.deepEqual(await box(page, "right"), right)

    // At the minimum sidebar width every header action stays inside the panel.
    const handle = (await page.locator(".session-resize-handle--left").boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, 300)
    await page.mouse.down()
    await page.mouse.move(100, 300, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector(".session-sidebar-container")!.getBoundingClientRect().width <= 221)
    const clipped = await page.evaluate(() => {
      const panel = document.querySelector(".session-sidebar-container")!.getBoundingClientRect()
      return [...document.querySelectorAll(".session-sidebar-header-actions button")].flatMap(button => {
        const rect = button.getBoundingClientRect()
        return rect.left >= panel.left && rect.right <= panel.right ? [] : [button.getAttribute("aria-label")]
      })
    })
    assert.deepEqual(clipped, [])
    assert.deepEqual(await overlaps(page), [])
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

for (const rtl of [false, true]) test(`${rtl ? "RTL " : ""}phone overlays keep both toggles fixed, reachable and exclusive`, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true })
  const { page, errors } = await open(context)
  try {
    if (rtl) {
      await page.evaluate(() => (window as any).fixture.setLocale("he"))
      await page.waitForFunction(() => document.documentElement.dir === "rtl")
    }
    await waitDrawers(page, "closed", "closed")
    const left = await box(page, "left"), right = await box(page, "right")
    assert.ok(rtl ? left.x > right.x : left.x < right.x, "the session toggle sits at the leading edge")
    const [leading, trailing] = rtl ? [right, left] : [left, right]
    assert.equal(leading.x, 4)
    assert.equal(390 - (trailing.x + trailing.width), 4)
    assert.deepEqual(await overlaps(page), [])

    await toggle(page, "left").tap()
    await waitDrawers(page, "floating", "closed")
    assert.deepEqual(await box(page, "left"), left)
    assert.deepEqual(await box(page, "right"), right)
    assert.equal(await toggle(page, "left").getAttribute("aria-expanded"), "true")
    assert.deepEqual(await hiddenAncestors(page), [], "modal isolation never hides the fixed toggles")
    assert.deepEqual(await overlaps(page), [])

    // Opening the other overlay replaces the first one.
    await toggle(page, "right").tap()
    await waitDrawers(page, "closed", "floating")
    assert.deepEqual(await box(page, "left"), left)
    assert.deepEqual(await box(page, "right"), right)
    assert.deepEqual(await hiddenAncestors(page), [])
    assert.deepEqual(await overlaps(page), [])

    await toggle(page, "right").tap()
    await waitDrawers(page, "closed", "closed")
    assert.equal(await toggle(page, "right").getAttribute("aria-expanded"), "false")

    // Immersive mode hides the conversation chrome and its toggles together.
    await page.evaluate(() => (window as any).fixture.setImmersive(true))
    await page.waitForFunction(() => !document.querySelector(".shell-panel-toggle"))
    await page.evaluate(() => (window as any).fixture.setImmersive(false))
    await toggle(page, "left").waitFor()
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

const selectFromList = (page: Page, sessionId: string) =>
  page.locator(`.session-sidebar [data-session-id="${sessionId}"] .session-item-select`).click()
const selected = (page: Page) => page.evaluate(() => (window as any).fixture.selectedSession())
const back = (page: Page) => page.getByRole("button", { name: "Previous session", exact: true })
const forward = (page: Page) => page.getByRole("button", { name: "Next session", exact: true })
async function waitSelected(page: Page, sessionId: string | null) {
  await page.waitForFunction(id => (window as any).fixture.selectedSession() === id, sessionId)
}

test("session history navigates like a browser without recording its own moves", async () => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const { page, errors } = await open(context)
  try {
    await page.evaluate(() => { for (const id of ["alpha", "beta", "gamma"]) (window as any).fixture.addSession(id) })
    await page.locator('.session-sidebar [data-session-id="gamma"]').waitFor()
    assert.equal(await back(page).isDisabled(), true, "a single visited session has no history")
    assert.equal(await forward(page).isDisabled(), true)
    // The header buttons replace the old close arrow at the same position.
    assert.equal(await page.locator(".session-sidebar-header-actions button").last().getAttribute("aria-label"), "Next session")

    for (const id of ["alpha", "beta", "gamma"]) { await selectFromList(page, id); await waitSelected(page, id) }
    await back(page).click(); await waitSelected(page, "beta")
    await back(page).click(); await waitSelected(page, "alpha")
    assert.equal(await forward(page).isEnabled(), true)
    await forward(page).click(); await waitSelected(page, "beta")
    await forward(page).click(); await waitSelected(page, "gamma")
    assert.equal(await forward(page).isDisabled(), true, "navigating did not push duplicate entries")

    // A new selection after going back truncates the forward stack.
    await back(page).click(); await waitSelected(page, "beta")
    await selectFromList(page, "session"); await waitSelected(page, "session")
    assert.equal(await forward(page).isDisabled(), true)
    await back(page).click(); await waitSelected(page, "beta")
    await back(page).click(); await waitSelected(page, "alpha")

    // Deleted conversations are skipped in both directions.
    await page.evaluate(() => (window as any).fixture.removeSession("beta"))
    await page.locator('.session-sidebar [data-session-id="beta"]').waitFor({ state: "detached" })
    await forward(page).click(); await waitSelected(page, "session")
    await back(page).click(); await waitSelected(page, "alpha")

    // Info and the no-session draft are not entries; Back returns to the shown conversation.
    await page.getByRole("button", { name: "Instance Info", exact: true }).click(); await waitSelected(page, "info")
    assert.equal(await back(page).isEnabled(), true)
    await back(page).click(); await waitSelected(page, "alpha")
    await page.evaluate(() => (window as any).fixture.selectSession(null)); await waitSelected(page, null)
    await back(page).click(); await waitSelected(page, "alpha")
    assert.equal(await forward(page).isEnabled(), true)
    await forward(page).click(); await waitSelected(page, "session")
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("phone history buttons act inside the session overlay like list selection", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true })
  const { page, errors } = await open(context)
  try {
    await page.evaluate(() => { for (const id of ["alpha", "beta"]) (window as any).fixture.addSession(id) })
    await toggle(page, "left").tap()
    await waitDrawers(page, "floating", "closed")
    await page.locator('.session-sidebar [data-session-id="alpha"] .session-item-select').tap()
    await waitSelected(page, "alpha")
    const afterSelection = (await drawers(page)).left
    await back(page).tap(); await waitSelected(page, "session")
    assert.equal((await drawers(page)).left, afterSelection, "history mirrors ordinary selection's drawer behaviour")
    await forward(page).tap(); await waitSelected(page, "alpha")
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
