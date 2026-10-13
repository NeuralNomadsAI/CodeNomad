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

/** `nativeHints` emulates a local Electron window whose session list header
 * shows the native shortcut-hint row (desktop layouts at 1280 px and above). */
async function open(context: BrowserContext, options: { nativeHints?: boolean } = {}) {
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  if (options.nativeHints) await page.addInitScript({ content: `
    window.__CODENOMAD_RUNTIME_HOST__ = "electron"
    window.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    window.electronAPI = { setWorkspaceMenuEnabled: async () => ({ ok: true }) }
  ` })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.goto(options.nativeHints ? `${url}?shortcutHints=1` : url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { page, errors }
}

const toggle = (page: Page, side: "left" | "right") => page.locator(`.shell-panel-toggle--${side} button`)
/** Horizontal placement only: each toggle follows its adjacent row vertically. */
const box = async (page: Page, side: "left" | "right") => {
  const rect = (await toggle(page, side).boundingBox())!
  return { x: Math.round(rect.x), width: Math.round(rect.width), height: Math.round(rect.height) }
}
/** Vertical offset between each toggle and the header row it sits beside. */
const misalignment = (page: Page, anchors: { left: string; right: string }) => page.evaluate(anchors => [
  [".shell-panel-toggle--left button", anchors.left],
  [".shell-panel-toggle--right button", anchors.right],
].map(([toggleSelector, anchorSelector]) => {
  const own = document.querySelector(toggleSelector)!.getBoundingClientRect()
  const row = [...document.querySelectorAll(anchorSelector)].find(el => el.getBoundingClientRect().height > 0)!.getBoundingClientRect()
  return Math.abs(own.top + own.height / 2 - (row.top + row.height / 2))
}), anchors)
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
    // Only the visible part counts: intersect with clipping ancestors (tab scrollers).
    const own = el.getBoundingClientRect()
    let left = own.left, right = own.right, top = own.top, bottom = own.bottom
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.overflowX === "visible" && style.overflowY === "visible") continue
      const clip = node.getBoundingClientRect()
      left = Math.max(left, clip.left); right = Math.min(right, clip.right)
      top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom)
    }
    if (right <= left || bottom <= top) return []
    return toggles.some(t => left < t.right && t.left < right && top < t.bottom && t.top < bottom)
      ? [el.getAttribute("aria-label") ?? el.textContent ?? el.className] : []
  })
})
/** Session list header actions that are clipped by the docked panel or not hit-testable. */
const unreachableHeaderActions = (page: Page) => page.evaluate(() => {
  const panel = document.querySelector(".session-sidebar-container")!.getBoundingClientRect()
  return [...document.querySelectorAll(".session-sidebar-header-actions button")].flatMap(button => {
    const rect = button.getBoundingClientRect()
    const inside = rect.width > 0 && rect.left >= panel.left && rect.right <= panel.right
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    // Disabled MUI buttons drop pointer events; their spot must still be their own row.
    const reachable = hit !== null && (button.contains(hit) || (button.disabled && hit === button.parentElement))
    return inside && reachable ? [] : [button.getAttribute("aria-label")]
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
    // Fixed labels: aria-expanded alone announces the state.
    assert.equal(await toggle(page, "left").getAttribute("aria-label"), "Left panel")
    assert.equal(await toggle(page, "right").getAttribute("aria-label"), "Right panel")
    assert.equal(await toggle(page, "left").getAttribute("aria-controls"), "session-sidebar-header-windows")
    // Both toggles precede the shell content in tab order, outside the drawer host.
    assert.deepEqual(await page.evaluate(() => {
      const panels = document.querySelector(".session-shell-panels")!
      return [...document.querySelectorAll(".shell-panel-toggle button")].map(button =>
        Boolean(button.compareDocumentPosition(panels) & Node.DOCUMENT_POSITION_FOLLOWING) && !panels.contains(button))
    }), [true, true])
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".shell-panel-toggle button")].map(b => b.getAttribute("aria-label"))),
      ["Left panel", "Right panel"])
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
    assert.equal(await toggle(page, "left").getAttribute("aria-label"), "Left panel")
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
    assert.deepEqual(await unreachableHeaderActions(page), [])
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
const back = (page: Page) => page.getByRole("button", { name: "Back", exact: true })
const forward = (page: Page) => page.getByRole("button", { name: "Forward", exact: true })
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
    assert.equal(await page.locator(".session-sidebar-header-actions button").last().getAttribute("aria-label"), "Forward")
    // History wording, distinct from the palette's "Previous/Next Session" list cycling.
    assert.equal(await back(page).getAttribute("title"), "Back to the previous conversation")
    assert.equal(await forward(page).getAttribute("title"), "Forward to the next conversation")

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

test("touch session list header keeps all five actions at the minimum docked width", async () => {
  // A touch tablet in landscape docks both panels; coarse pointers use compact targets.
  const context = await browser.newContext({ viewport: { width: 1366, height: 1024 }, hasTouch: true, isMobile: true })
  const { page, errors } = await open(context)
  try {
    await waitDrawers(page, "pinned", "pinned")
    await page.evaluate(() => { for (const id of ["alpha", "beta"]) (window as any).fixture.addSession(id) })
    for (const id of ["alpha", "beta"]) {
      await page.evaluate(id => (window as any).fixture.selectSession(id), id)
      await waitSelected(page, id)
    }
    await back(page).tap(); await waitSelected(page, "alpha")
    // Both history buttons are enabled, so each must receive its own taps.
    assert.equal(await back(page).isEnabled(), true)
    assert.equal(await forward(page).isEnabled(), true)

    const handle = (await page.locator(".session-resize-handle--left").boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, 400)
    await page.mouse.down()
    await page.mouse.move(60, 400, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector(".session-sidebar-container")!.getBoundingClientRect().width <= 221)
    assert.deepEqual(await unreachableHeaderActions(page), [])
    assert.deepEqual(await page.locator(".session-sidebar-header-actions button").evaluateAll(buttons =>
      buttons.map(button => Math.round(button.getBoundingClientRect().width))), [32, 32, 32, 32, 32])
    assert.deepEqual(await overlaps(page), [])
    await forward(page).tap(); await waitSelected(page, "beta")
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

/** Toggle rectangles relative to the shell frame, unrounded. */
const togglePositions = (page: Page) => page.evaluate(() => {
  const frame = document.querySelector(".session-shell-frame")!.getBoundingClientRect()
  return [...document.querySelectorAll(".shell-panel-toggle button")].map(button => {
    const rect = button.getBoundingClientRect()
    return { x: rect.left - frame.left, y: rect.top - frame.top, width: rect.width, height: rect.height }
  })
})
/** Settled drawer state: floating papers have finished sliding. */
async function settledDrawers(page: Page) {
  await page.waitForFunction(() => [...document.querySelectorAll(".session-floating-drawer .MuiDrawer-paper")]
    .every(paper => getComputedStyle(paper).transform === "none"))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return drawers(page)
}
/** The header row lying beside each toggle in a drawer state (floating drawers span the shell). */
const adjacentRows = (state: { left: string; right: string }) => ({
  left: state.left !== "closed" ? ".session-sidebar-header-actions"
    : state.right === "floating" ? ".tab-strip-shortcuts" : ".session-toolbar-left",
  right: state.right !== "closed" ? ".tab-strip-shortcuts"
    : state.left === "floating" ? ".session-sidebar-header-actions" : ".session-toolbar-right",
})
// Shared header action line (--panel-header-action-center).
const ACTION_CENTER = 27

const fixedLayouts = [
  { name: "desktop", options: { viewport: { width: 1600, height: 900 } }, nativeHints: false },
  { name: "desktop with the native shortcut-hint row", options: { viewport: { width: 1600, height: 900 } }, nativeHints: true },
  { name: "narrow desktop overlays", options: { viewport: { width: 640, height: 760 } }, nativeHints: false },
  { name: "phone overlays", options: { viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true }, nativeHints: false },
]
for (const layout of fixedLayouts) test(`toggles stay strictly fixed on one header line: ${layout.name}`, async () => {
  const context = await browser.newContext(layout.options)
  const { page, errors } = await open(context, { nativeHints: layout.nativeHints })
  try {
    if (layout.nativeHints) await page.locator(".session-sidebar-shortcuts .keyboard-hints").waitFor()
    let expected: Awaited<ReturnType<typeof togglePositions>> | undefined
    const seen = new Set<string>()
    // Visit all four open/closed combinations and come back.
    for (const step of ["initial", "left", "right", "left", "right"] as const) {
      if (step !== "initial") {
        if (layout.options.hasTouch) await toggle(page, step).tap(); else await toggle(page, step).click()
      }
      const state = await settledDrawers(page)
      const label = `${step} -> ${state.left}/${state.right}`
      seen.add(`${state.left}/${state.right}`)
      const positions = await togglePositions(page)
      expected ??= positions
      positions.forEach((rect, index) => {
        for (const key of ["x", "y", "width", "height"] as const) {
          assert.ok(Math.abs(rect[key] - expected![index][key]) <= 0.5, `${label}: toggle ${index} ${key} ${rect[key]} != ${expected![index][key]}`)
        }
        assert.ok(Math.abs(rect.y + rect.height / 2 - ACTION_CENTER) <= 0.5, `${label}: toggle ${index} centre ${rect.y + rect.height / 2}`)
      })
      const rows = adjacentRows(state)
      const offsets = await misalignment(page, rows)
      offsets.forEach((offset, index) => assert.ok(offset <= 0.5, `${label}: toggle ${index} is ${offset}px off ${Object.values(rows)[index]}`))
      assert.deepEqual(await overlaps(page), [], label)
    }
    if (layout.options.viewport.width < 1280) assert.ok([...seen].some(state => state.includes("floating")), "an overlay state was exercised")
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("native shortcut hints form a footer below the scrolling session list", async () => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 700 } })
  const { page, errors } = await open(context, { nativeHints: true })
  try {
    await page.evaluate(() => { for (let index = 0; index < 40; index += 1) (window as any).fixture.addSession(`many-${index}`) })
    const footer = page.locator(".session-sidebar-shortcuts")
    await footer.locator(".keyboard-hints").waitFor()
    assert.equal(await page.locator(".session-sidebar-header .keyboard-hints").count(), 0, "the header keeps a single action row")
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".session-sidebar-container")!.getBoundingClientRect()
      const foot = document.querySelector(".session-sidebar-shortcuts")!.getBoundingClientRect()
      const list = document.querySelector<HTMLElement>(".session-sidebar .session-list")!
      list.scrollTop = list.scrollHeight
      return { panelBottom: panel.bottom, footTop: foot.top, footBottom: foot.bottom, footHeight: foot.height,
        listBottom: list.getBoundingClientRect().bottom, scrollable: list.scrollHeight > list.clientHeight }
    })
    assert.ok(geometry.footHeight > 0)
    assert.ok(Math.abs(geometry.footBottom - geometry.panelBottom) <= 0.5, "footer sits at the panel bottom")
    assert.ok(geometry.listBottom <= geometry.footTop + 0.5, "the list scrolls above the footer")
    assert.ok(geometry.scrollable, "the fixture list overflows")
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".session-sidebar [data-session-id]")]
      const last = rows[rows.length - 1]?.getBoundingClientRect()
      const foot = document.querySelector(".session-sidebar-shortcuts")!.getBoundingClientRect()
      return last !== undefined && last.bottom <= foot.top + 0.5
    })
    // Hits on the footer's centre land on the hint row, not on a list row underneath.
    assert.equal(await footer.evaluate(el => {
      const rect = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
    }), true)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("without hints the session list panel has no footer", async () => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const { page, errors } = await open(context)
  try {
    await waitDrawers(page, "pinned", "pinned")
    assert.equal(await page.locator(".session-sidebar-shortcuts").evaluateAll(nodes =>
      nodes.reduce((height, node) => height + node.getBoundingClientRect().height, 0)), 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("body-portaled dialogs and utility windows paint above the fixed toggles", async () => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
  const { page, errors } = await open(context)
  try {
    const hitsToggle = (side: "left" | "right") => toggle(page, side).evaluate(el => {
      const rect = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
    })
    assert.equal(await hitsToggle("left"), true)
    assert.equal(await hitsToggle("right"), true)

    // A modal scrim covers (and dims) both toggles.
    await page.locator('.session-sidebar [data-session-id="session"]').hover()
    await page.getByRole("button", { name: "Rename session", exact: true }).first().click()
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    assert.equal(await hitsToggle("left"), false)
    assert.equal(await hitsToggle("right"), false)
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
    assert.equal(await hitsToggle("right"), true)

    // A utility window dragged over the corner keeps its own close button on top.
    // At this width the header search button lives in the overflow menu.
    await page.keyboard.press("Control+f")
    const panel = page.locator('[role="dialog"][id^="session-search-"]')
    await panel.waitFor()
    const handle = (await panel.locator("[data-window-drag-handle]").boundingBox())!
    await page.mouse.move(handle.x + handle.width - 4, handle.y + 4)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width + 2000, handle.y - 2000, { steps: 5 })
    await page.mouse.up()
    const covered = await panel.evaluate((el, toggleRect) => {
      const rect = el.getBoundingClientRect()
      return rect.left < toggleRect.x + toggleRect.width && rect.right > toggleRect.x && rect.top < toggleRect.y + toggleRect.height && rect.bottom > toggleRect.y
    }, (await toggle(page, "right").boundingBox())!)
    assert.equal(covered, true, "the dragged window overlaps the right toggle")
    assert.equal(await hitsToggle("right"), false)
    const close = panel.locator(".window-close-button")
    assert.equal(await close.evaluate(el => {
      const rect = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
    }), true)
    await close.click()
    await panel.waitFor({ state: "hidden" })
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
