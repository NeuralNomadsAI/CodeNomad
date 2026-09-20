import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { readNavigationWindow, readSessionOutline } from "../../../server/src/opencode/session-pruning/navigation-store"
import { navigationMessage, navigationMessageId } from "./fixtures/history-navigation-data"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "navigation-fixture", configureServer(server) {
      server.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await server.transformIndexHtml("/fixture", '<html><body><div id="root" style="display:flex;width:1100px;height:740px"></div><script type="module" src="/tests/browser/fixtures/history-navigation.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
    CREATE UNIQUE INDEX seq_idx ON session_message(session_id,seq);
    INSERT INTO session_v2 VALUES ('s','/fixture','p',NULL,NULL);`)
  const insert = db.prepare("INSERT INTO session_message VALUES (?,'s','user',?,?)")
  for (let index = 0; index < 1500; index++) {
    const { id, type: _type, ...data } = navigationMessage(index)
    insert.run(id, index, JSON.stringify(data))
  }
  const errors: string[] = [], windows: any[] = []
  const reads = new Set<Promise<unknown>>()
  let hold: { messageID: string; release: () => void; promise: Promise<void> } | undefined
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", async route => {
    const request = route.request(), method = request.url().split("/").at(-1)
    if (!request.url().includes("/session-history/") || !["outline", "window"].includes(method!)) {
      return route.fulfill({ contentType: "application/json", body: "{}" })
    }
    const input = request.postDataJSON()
    const scope = { directory: "/fixture", projectID: "p", sessionID: "s" }
    const read = method === "window"
      ? readNavigationWindow(db, scope, input.target, new AbortController().signal)
      : readSessionOutline(db, scope, input.cursor, new AbortController().signal)
    reads.add(read)
    const response = await read.finally(() => reads.delete(read))
    if (method === "window") {
      windows.push(input.target)
      if (input.target.messageID === hold?.messageID) await hold!.promise
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) }).catch(() => {})
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await page.locator('.message-timeline[data-segment-count="1500"]').waitFor()
  return { page, windows, errors,
    hold: (index: number) => {
      let release!: () => void
      const promise = new Promise<void>(done => { release = done })
      hold = { messageID: navigationMessageId(index), release, promise }
      return release
    },
    close: async () => { hold?.release(); await page.close(); await Promise.allSettled(reads); db.close() },
  }
}

async function clickTimeline(page: Page, index: number) {
  await page.locator(".message-timeline").evaluate((element, index) => {
    element.scrollTop = element.scrollHeight * index / 1500
  }, index)
  await page.locator(`.message-timeline-segment[data-message-id="${navigationMessageId(index)}"]`).click()
}
const snapshot = (page: Page) => page.evaluate(() => (window as any).fixture.snapshot())

test("global timeline jumps over 1200 messages in one bounded window and restores the selected passage", async () => {
  const f = await fixture()
  try {
    const before = await snapshot(f.page)
    assert.equal(before.ids.length, 200)
    assert.equal(before.ids[0], navigationMessageId(1300))
    await clickTimeline(f.page, 250)
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids.includes("msg_00250"))
    await f.page.locator('.message-stream [data-message-id="msg_00250"]').first().waitFor()
    const jumped = await snapshot(f.page)
    assert.equal(f.windows.length, 1)
    assert.equal(jumped.nativeLists, before.nativeLists, "jump does not replay native pages")
    assert.equal(jumped.ids.length, 200)
    assert.equal(jumped.window.kind, "history")
    assert.deepEqual(jumped.model, before.model)
    await f.page.evaluate(() => (window as any).fixture.reload())
    const restored = await snapshot(f.page)
    assert.deepEqual(restored.ids, jumped.ids)
    assert.equal(f.windows.length, 2)
    await f.page.evaluate(() => (window as any).fixture.stream("Live response while reading the old passage"))
    assert.deepEqual((await snapshot(f.page)).ids, jumped.ids, "native streaming does not replace the historical window")
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.locator(".message-stream").waitFor()
    assert((await snapshot(f.page)).ids.includes(navigationMessageId(250)))
    assert.deepEqual(f.errors, [])
    const captures = path.join(os.tmpdir(), "opencode"); await mkdir(captures, { recursive: true })
    await f.page.screenshot({ path: path.join(captures, "history-navigation.png") })
  } finally { await f.close() }
})

test("latest timeline intent supersedes a slow far jump, including a resident destination", async () => {
  const f = await fixture()
  try {
    const release = f.hold(250)
    await clickTimeline(f.page, 250)
    await f.page.locator(".history-navigation-status").waitFor()
    await clickTimeline(f.page, 1450)
    await f.page.locator(".history-navigation-status").waitFor({ state: "hidden" })
    release()
    await f.page.waitForTimeout(150)
    const state = await snapshot(f.page)
    assert(state.ids.includes(navigationMessageId(1450)))
    assert(!state.ids.includes(navigationMessageId(250)))
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("timeline gutter stays fixed across overflow, hover, focus, RTL and fractional zoom", async () => {
  const f = await fixture()
  try {
    const rail = f.page.locator(".message-timeline")
    for (const direction of ["ltr", "rtl"]) for (const zoom of [1, 1.25]) {
      await f.page.evaluate(({ direction, zoom }) => { document.documentElement.dir = direction; document.body.style.zoom = String(zoom) }, { direction, zoom })
      const measure = () => rail.evaluate(element => {
        const style = getComputedStyle(element)
        return { width: element.clientWidth, gutter: element.offsetWidth - element.clientWidth, scrollbar: style.scrollbarWidth,
          segment: element.querySelector(".message-timeline-segment")!.getBoundingClientRect().width,
          height: element.querySelector(".message-timeline-segment")!.getBoundingClientRect().height,
          icon: element.querySelector(".message-timeline-icon")!.getBoundingClientRect().width }
      })
      const normal = await measure()
      assert.notEqual(normal.scrollbar, "none")
      assert(normal.gutter > 0 && normal.gutter <= 10, JSON.stringify({ direction, zoom, normal }))
      await rail.hover()
      const hover = await measure()
      assert.equal(hover.width, normal.width)
      assert.equal(hover.segment, normal.segment)
      assert.equal(hover.height, normal.height)
      assert.equal(hover.icon, normal.icon)
      await rail.locator("button").first().focus()
      assert.equal((await measure()).width, normal.width)
      await rail.evaluate(element => { element.style.overflowY = "hidden" })
      assert.equal((await measure()).width, normal.width, "reserved gutter remains without overflow")
      await rail.evaluate(element => { element.style.overflowY = "auto" })
      await rail.evaluate(element => { element.style.scrollbarGutter = "auto"; element.style.setProperty("scrollbar-width", "none", "important") })
      const withoutGutter = await measure()
      assert(withoutGutter.segment > normal.segment, "only the surrounding rectangle gives up width to the gutter")
      assert.equal(withoutGutter.icon, normal.icon, "icons never scale to fit the narrower rail")
      assert.equal(withoutGutter.height, normal.height, "vertical geometry does not scale with width")
      await rail.evaluate(element => { element.style.removeProperty("scrollbar-gutter"); element.style.removeProperty("scrollbar-width") })
    }
  } finally { await f.close() }
})

test("a newer distant destination wins and a hidden session rejects a pending jump", async () => {
  const f = await fixture()
  try {
    const release = f.hold(250)
    await clickTimeline(f.page, 250)
    await f.page.locator(".history-navigation-status").waitFor()
    await clickTimeline(f.page, 900)
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids.includes("msg_00900"))
    release()
    await f.page.locator(".history-navigation-status").waitFor({ state: "hidden" })
    assert.equal(f.windows.length, 2)
    assert(!(await snapshot(f.page)).ids.includes(navigationMessageId(250)))
    const releaseHidden = f.hold(100)
    await clickTimeline(f.page, 100)
    await f.page.locator(".history-navigation-status").waitFor()
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    releaseHidden()
    await f.page.waitForTimeout(150)
    assert((await snapshot(f.page)).ids.includes(navigationMessageId(900)))
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("current-session search clicks and keyboard next use direct distant windows", async () => {
  const f = await fixture()
  try {
    await f.page.route("**/session-history/query", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
      status: "page", scanned: 1500, tools: 0, reasoning: 0, skipped: 0, candidates: [], cursor: null,
      hits: [250, 900].map(index => ({ sessionID: "s", messageID: navigationMessageId(index), role: "user", partIndex: 0,
        kind: "text", excerpt: `Search result ${index}` })),
    }) }))
    const initial = await snapshot(f.page)
    await f.page.evaluate(() => (window as any).fixture.openSearch())
    await f.page.getByRole("searchbox").fill("Passage")
    await f.page.locator(".history-search-result").first().click()
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids.includes("msg_00250"))
    await f.page.getByRole("searchbox").press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids.includes("msg_00900"))
    assert.deepEqual(f.windows.map(target => target.messageID), [navigationMessageId(250), navigationMessageId(900)])
    assert.equal((await snapshot(f.page)).nativeLists, initial.nativeLists)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
