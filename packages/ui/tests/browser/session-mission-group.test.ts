import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

// Optional visual evidence: set SESSION_MISSION_CAPTURES to a directory.
const captures = process.env.SESSION_MISSION_CAPTURES
let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)),
      logLevel: "error", cacheDir: cache.cacheDir, plugins: [solid(), shutdown.plugin, {
        name: "session-mission-group-fixture", configureServer(s) {
          s.middlewares.use("/fixture", async (_req, res) => {
            res.setHeader("Content-Type", "text/html")
            res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-mission-group.tsx"></script></body></html>'))
          })
        },
      }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
    shutdown.own(server); await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    if (captures) await mkdir(captures, { recursive: true })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
}, { timeout: 60000 })
after(async () => { try { await browser?.close() } finally { await server?.close() } })

const rows = (page: Page) => page.locator(".session-item-base[data-session-id]")
  .evaluateAll(elements => elements.map(el => el.getAttribute("data-session-id")))
const fixture = (page: Page, script: string) => page.evaluate(`window.fixture.${script}`)
async function open(page: Page, dir: "ltr" | "rtl" = "ltr") {
  await page.addInitScript(`
    Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", electronAPI: {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: JSON.parse(localStorage.getItem("fixture-native") ?? "null") }),
      saveClientState: async (_token, snapshot) => { localStorage.setItem("fixture-native", JSON.stringify(snapshot)); return true },
    } })
  `)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await page.evaluate(value => { document.documentElement.dir = value }, dir)
  await page.locator("[data-mission-group-row]").waitFor()
}
async function capture(page: Page, name: string) {
  if (captures) await page.locator(".session-list-container").screenshot({ path: path.join(captures, `${name}.png`) })
}

test("Mission roots gather in one collapsed trailing group that surfaces attention and reveals navigation", async () => {
  const page = await browser.newPage({ viewport: { width: 480, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page)
    const group = page.locator("[data-mission-group-row]")
    assert.deepEqual(await rows(page), ["user-a"], "collapsed by default: only ordinary conversations are listed")
    assert.equal(await group.getAttribute("aria-expanded"), "false")
    assert.equal(await page.locator(".session-mission-group-count").innerText(), "3")
    assert.equal(await page.locator("[data-mission-group-activity]").count(), 0)
    assert.deepEqual(await fixture(page, "visible()"), ["user-a"], "keyboard order skips hidden Mission rows")
    await capture(page, "collapsed")

    await fixture(page, `patch("task-child", { pendingPermission: true })`)
    await page.locator('[data-mission-group-activity="input"]').waitFor()
    assert.match(await group.getAttribute("aria-label") ?? "", /Needs Input/)
    await capture(page, "collapsed-attention")
    await fixture(page, `patch("task-child", { pendingPermission: false })`)
    await fixture(page, `patch("coord2", { status: "working" })`)
    await page.locator('[data-mission-group-activity="working"]').waitFor()

    await group.click()
    assert.equal(await group.getAttribute("aria-expanded"), "true")
    assert.deepEqual(await rows(page), ["user-a", "coord", "coord2", "orphan-task"])
    await page.locator('[data-session-id="orphan-task"] .session-item-title').waitFor({ state: "visible" })
    assert.equal(await page.locator('[data-session-id="coord"] .session-item-title').innerText(), "Livrer une application")
    assert.equal(await page.locator('[data-session-id="orphan-task"] .session-item-title').innerText(), "reviewer: Orphaned task")
    await page.locator('[data-session-id="coord"] .session-item-expander').click()
    assert.deepEqual(await rows(page), ["user-a", "coord", "task", "coord2", "orphan-task"], "task roots nest under their coordinator")
    const indent = (sessionId: string) => page.locator(`[data-session-id="${sessionId}"]`).evaluate(el => parseFloat(getComputedStyle(el).paddingInlineStart))
    assert.ok(await indent("task") > await indent("coord"))
    assert.ok(await indent("coord") > await indent("user-a"))
    await capture(page, "expanded")

    await fixture(page, "flush()")
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.locator('[data-session-id="coord"]').waitFor()
    assert.equal(await group.getAttribute("aria-expanded"), "true", "open state persists across reload")
    await group.click()
    await page.locator('[data-mission-group-row][aria-expanded="false"]').waitFor()
    await fixture(page, "flush()")
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await group.waitFor()
    assert.equal(await group.getAttribute("aria-expanded"), "false")

    await fixture(page, `setActive("task-child")`)
    await page.locator('[data-session-id="task-child"].session-item-active').waitFor()
    assert.equal(await group.getAttribute("aria-expanded"), "true", "navigation auto-expands the group")
    assert.deepEqual((await rows(page)).slice(1, 4), ["coord", "task", "task-child"])
    await capture(page, "revealed")

    await fixture(page, "setSearchMode(true)")
    await page.getByRole("textbox", { name: "Search sessions" }).waitFor()
    assert.equal(await page.locator("[data-mission-group-row]").count(), 0, "search stays flat")
    assert.equal(await page.locator('[data-session-id="coord"] .session-mission-badge').innerText(), "Mission")
    assert.equal(await page.locator('[data-session-id="user-a"] .session-mission-badge').count(), 0)
    await page.getByRole("switch", { name: "Show subsessions" }).check()
    await page.locator('[data-session-id="task-child"] .session-mission-badge').waitFor()
    assert.equal(await page.locator('[data-session-id="user-a-child"] .session-mission-badge').count(), 0)
    await capture(page, "search-badges")
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, body: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})

test("the group row keeps square tree geometry in RTL touch layouts", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true })
  try {
    await open(page, "rtl")
    const group = page.locator("[data-mission-group-row]")
    await group.click()
    await page.locator('[data-session-id="coord"]').waitFor()
    const geometry = await page.evaluate(() => {
      const toggle = document.querySelector<HTMLElement>("[data-mission-group-row]")!
      const coord = document.querySelector<HTMLElement>('[data-session-id="coord"]')!
      const user = document.querySelector<HTMLElement>('[data-session-id="user-a"]')!
      return {
        coarse: matchMedia("(pointer: coarse)").matches,
        touch: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--touch-target-size")) || 0,
        toggleHeight: toggle.getBoundingClientRect().height,
        radius: getComputedStyle(toggle).borderTopLeftRadius,
        chevronRight: toggle.querySelector(".session-item-expander")!.getBoundingClientRect().right,
        titleRight: toggle.querySelector(".session-item-title")!.getBoundingClientRect().right,
        coordRight: coord.querySelector(".session-item-expander")!.getBoundingClientRect().right,
        userRight: user.querySelector(".session-item-expander")!.getBoundingClientRect().right,
      }
    })
    assert.equal(geometry.coarse, true)
    assert.ok(geometry.toggleHeight >= geometry.touch, `toggle ${geometry.toggleHeight} >= touch ${geometry.touch}`)
    assert.equal(geometry.radius, "0px")
    assert.ok(geometry.chevronRight > geometry.titleRight, "chevron leads at the inline start in RTL")
    assert.ok(geometry.coordRight < geometry.userRight, "Mission members indent from the RTL inline start")
    await capture(page, "rtl-touch")
  } finally { await page.close() }
})
