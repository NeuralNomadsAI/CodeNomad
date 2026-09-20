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
import { navigationMessage, navigationMessageId, mixedNavigationMessage } from "./fixtures/history-navigation-data"

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
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined,
    ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] })
})
after(async () => { await browser?.close(); await server?.close() })

async function fixture(mixed = false, pauseOutline = false) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
    CREATE UNIQUE INDEX seq_idx ON session_message(session_id,seq);
    INSERT INTO session_v2 VALUES ('s','/fixture','p',NULL,NULL);`)
  const insert = db.prepare("INSERT INTO session_message VALUES (?,'s',?,?,?)")
  for (let index = 0; index < 1500; index++) {
    const { id, type, ...data } = (mixed ? mixedNavigationMessage : navigationMessage)(index)
    insert.run(id, type, index, JSON.stringify(data))
  }
  const errors: string[] = [], windows: any[] = []
  const outlines: Array<number | undefined> = []
  let resumeOutline!: () => void
  const outlineGate = new Promise<void>(resolve => { resumeOutline = resolve })
  const reads = new Set<Promise<unknown>>()
  let hold: { messageID: string; release: () => void; promise: Promise<void> } | undefined
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", async route => {
    const request = route.request(), method = request.url().split("/").at(-1)
    if (!request.url().includes("/session-history/") || !["outline", "window"].includes(method!)) {
      return route.fulfill({ contentType: "application/json", body: "{}" })
    }
    const input = request.postDataJSON()
    if (method === 'outline') {
      outlines.push(input.cursor?.after)
      if (pauseOutline && input.cursor) await outlineGate
    }
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
  await page.goto(url + (mixed ? "?mixed" : ""))
  await page.waitForFunction(() => Boolean((window as any).fixture))
  if (!pauseOutline) await page.locator('.message-timeline[data-segment-count="1500"]').waitFor()
  return { page, windows, errors, outlines, resumeOutline,
    hold: (index: number) => {
      let release!: () => void
      const promise = new Promise<void>(done => { release = done })
      hold = { messageID: navigationMessageId(index), release, promise }
      return release
    },
    close: async () => { hold?.release(); resumeOutline(); await page.close(); await Promise.allSettled(reads); db.close() },
  }
}

async function clickTimeline(page: Page, index: number, checkReaderPosition = false) {
  await page.locator('.message-timeline').hover()
  await page.locator(".message-timeline").evaluate((element, index) => {
    element.scrollTop = element.scrollHeight * index / 1500
  }, index)
  if (checkReaderPosition) {
    // Let the prior selection's 120ms reveal expire while the reader is
    // browsing elsewhere. It must not reclaim the rail or animate the target.
    await page.waitForTimeout(250)
    const target = await page.locator(`.message-timeline-segment[data-message-id="${navigationMessageId(index)}"]`).boundingBox()
    const rail = await page.locator(".message-timeline").boundingBox()
    assert(target && rail && target.y >= rail.y && target.y < rail.y + rail.height, "reader's destination remains visible before clicking")
  }
  await page.locator(`.message-timeline-segment[data-message-id="${navigationMessageId(index)}"]`).click()
}
const snapshot = (page: Page) => page.evaluate(() => (window as any).fixture.snapshot())

test("returning during an incomplete outline resumes accepted pages and retains the completed rail", async () => {
  const f = await fixture(false, true)
  try {
    await f.page.waitForFunction(() => document.querySelector('.history-navigation-status[role="status"]')?.textContent?.includes('256'))
    await f.page.evaluate(() => (window as any).fixture.status('working'))
    await f.page.waitForTimeout(200)
    await f.page.evaluate(() => (window as any).fixture.status('idle'))
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await f.page.evaluate(() => (window as any).fixture.return())
    f.resumeOutline()
    await f.page.locator('.message-timeline[data-segment-count="1500"]').waitFor()
    assert.equal(f.outlines.filter(cursor => cursor === undefined).length, 1, 'return must not discard accepted outline pages')
    const count = f.outlines.length
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.locator('.message-timeline[data-segment-count="1500"]').waitFor()
    await f.page.waitForTimeout(400)
    assert.equal(f.outlines.length, count, 'completed unchanged outline is immediately reusable on return')
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

async function assertPassageAtTop(page: Page, index: number) {
  await page.waitForFunction(id => {
    const stream = document.querySelector('.message-stream')!
    const row = stream.querySelector(`[data-virtual-follow-key="${id}"]`)
    return row && Math.abs(row.getBoundingClientRect().top - stream.getBoundingClientRect().top) < 2
  }, navigationMessageId(index))
  await page.waitForTimeout(500)
  const offset = await page.locator(`[data-virtual-follow-key="${navigationMessageId(index)}"]`).evaluate(row =>
    row.getBoundingClientRect().top - document.querySelector('.message-stream')!.getBoundingClientRect().top)
  assert(Math.abs(offset) < 2, `selected passage ${index} moved by ${offset}px`)
}

test("global timeline jumps over 1200 messages in one bounded window and restores the selected passage", async () => {
  const f = await fixture()
  try {
    const before = await snapshot(f.page)
    assert.equal(before.ids.length, 200)
    assert.equal(before.ids[0], navigationMessageId(1300))
    await clickTimeline(f.page, 250)
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids.includes("msg_00250"))
    await f.page.locator('.message-stream [data-message-id="msg_00250"]').first().waitFor()
    await assertPassageAtTop(f.page, 250)
    const jumped = await snapshot(f.page)
    assert.equal(f.windows.length, 1)
    assert.equal(jumped.nativeLists, before.nativeLists, "jump does not replay native pages")
    assert.equal(jumped.ids.length, 200)
    assert.equal(jumped.window.kind, "history")
    assert.deepEqual(jumped.model, before.model)
    await f.page.evaluate(() => (window as any).fixture.reload())
    await assertPassageAtTop(f.page, 250)
    const restored = await snapshot(f.page)
    assert.deepEqual(restored.ids, jumped.ids)
    assert.equal(f.windows.length, 2)
    const marker = await f.page.locator('.message-timeline-segment[data-message-id="msg_00250"]').elementHandle()
    assert(marker)
    await f.page.evaluate(() => (window as any).fixture.stream("Live response while reading the old passage"))
    assert.deepEqual((await snapshot(f.page)).ids, jumped.ids, "native streaming does not replace the historical window")
    assert(await marker.evaluate(element => element.isConnected), "streaming retains the historical marker's DOM identity")
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.locator(".message-stream").waitFor()
    await assertPassageAtTop(f.page, 250)
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
    await clickTimeline(f.page, 1450, true)
    await f.page.locator(".history-navigation-status").waitFor({ state: "hidden" })
    release()
    await f.page.waitForTimeout(150)
    const state = await snapshot(f.page)
    assert(state.ids.includes(navigationMessageId(1450)))
    assert(!state.ids.includes(navigationMessageId(250)))
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("resident streaming keeps a distant timeline marker mounted", async () => {
  const f = await fixture()
  try {
    await f.page.locator(".message-timeline").evaluate(element => { element.scrollTop = element.scrollHeight * 250 / 1500 })
    const marker = f.page.locator('.message-timeline-segment[data-message-id="msg_00250"]')
    await marker.waitFor()
    const retained = await marker.evaluate(element => {
      ;(window as any).fixture.stream("A new resident response while browsing old timeline markers")
      return element.isConnected
    })
    assert(retained, "a resident content update must not remount an unchanged distant click target")
    assert((await snapshot(f.page)).ids.includes("msg_streaming"), "the resident transcript did receive the streamed message")
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("mixed timeline keeps an exact scrollbar extent throughout manual browsing and hidden tools", async () => {
  const f = await fixture(true)
  try {
    const rail = f.page.locator('.message-timeline')
    for (const tools of [true, false]) {
      await f.page.evaluate(tools => (window as any).fixture.tools(tools), tools)
      await rail.hover()
      await f.page.waitForTimeout(400)
      const heights: number[] = []
      for (const fraction of [0, 0.25, 0.75, 0.5, 1, 0]) {
        await rail.evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction }, fraction)
        await f.page.waitForTimeout(200)
        heights.push(await rail.evaluate(element => element.scrollHeight))
      }
      assert(Math.max(...heights) - Math.min(...heights) <= 1, `scrollbar extent changes while browsing (tools=${tools}): ${heights}`)
    }
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("mixed transcript lands on the clicked message after distant jumps and retains it during streaming", async () => {
  const f = await fixture(true)
  try {
    for (const index of [250, 900, 100, 1450]) {
      await clickTimeline(f.page, index)
      await assertPassageAtTop(f.page, index)
      await f.page.evaluate(() => (window as any).fixture.stream('Another token. '))
      await assertPassageAtTop(f.page, index)
    }
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

async function dragNativeThumb(page: Page, selector: string, fraction: number) {
  await page.locator(selector).hover()
  await page.evaluate(() => new Promise(requestAnimationFrame))
  const geometry = await page.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect()
    const inset = element.offsetWidth - element.clientWidth
    const track = element.clientHeight - inset * 2
    const height = Math.max(18, track * element.clientHeight / element.scrollHeight)
    const travel = track - height
    const ratio = element.scrollTop / (element.scrollHeight - element.clientHeight)
    return { x: rect.right - inset / 2, top: rect.top + inset, height, travel,
      y: ratio > 0.99 ? rect.bottom - 16 : ratio < 0.01 ? rect.top + 16 : rect.top + inset + height / 2 + travel * ratio }
  })
  await page.mouse.move(geometry.x, geometry.y)
  await page.mouse.down()
  await page.waitForTimeout(750)
  await page.mouse.move(geometry.x, geometry.top + geometry.height / 2 + geometry.travel * fraction, { steps: 12 })
  await page.mouse.up()
}

test("native transcript thumb remains under reader control after a held press", async () => {
  const f = await fixture(true)
  try {
    await f.page.waitForTimeout(500)
    await dragNativeThumb(f.page, '.message-stream', 0.5)
    await f.page.waitForTimeout(500)
    const ratio = await f.page.locator('.message-stream').evaluate(element => element.scrollTop / (element.scrollHeight - element.clientHeight))
    assert(ratio > 0.2 && ratio < 0.8, `native thumb snapped away from middle: ${ratio}`)
    const before = await f.page.locator('.message-stream').evaluate(element => {
      const top = element.getBoundingClientRect().top
      const row = Array.from(element.querySelectorAll<HTMLElement>('[data-virtual-follow-key]')).find(row => {
        const rect = row.getBoundingClientRect()
        return rect.top <= top && rect.bottom > top
      })!
      return { key: row.dataset.virtualFollowKey, offset: row.getBoundingClientRect().top - top }
    })
    await f.page.evaluate(() => (window as any).fixture.stream('Streaming during manual scrollbar reading.'))
    await f.page.waitForTimeout(400)
    const after = await f.page.locator(`[data-virtual-follow-key="${before.key}"]`).evaluate(element =>
      element.getBoundingClientRect().top - document.querySelector('.message-stream')!.getBoundingClientRect().top)
    assert(Math.abs(before.offset - after) < 2, `streaming displaced visible passage: ${before.offset} -> ${after}`)
  } finally { await f.close() }
})

test("wheel at a stationary historical boundary opens the adjacent window", async () => {
  const f = await fixture(true)
  try {
    await clickTimeline(f.page, 250)
    await assertPassageAtTop(f.page, 250)
    const before = await snapshot(f.page)
    await f.page.locator('.message-stream[tabindex]').evaluate(element => { element.scrollTop = 0 })
    await f.page.waitForTimeout(500)
    const stream = await f.page.locator('.message-stream[tabindex]').boundingBox()
    assert(stream)
    await f.page.mouse.move(stream.x + 25, stream.y + 25)
    await f.page.mouse.wheel(0, -200)
    await f.page.waitForFunction(id => (window as any).fixture.snapshot().ids[0] !== id, before.ids[0], { timeout: 4000 })
    await assertPassageAtTop(f.page, 170)
    const older = await snapshot(f.page)
    await f.page.locator('.message-stream[tabindex]').evaluate(element => { element.scrollTop = element.scrollHeight })
    await f.page.waitForTimeout(500)
    await f.page.mouse.wheel(0, 200)
    await f.page.waitForFunction(id => (window as any).fixture.snapshot().ids.at(-1) !== id, older.ids.at(-1), { timeout: 4000 })
    assert((await snapshot(f.page)).ids.includes(older.ids.at(-2)), 'newer window retains the boundary passage')
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("first/latest controls remain available at local boundaries and land at actual global ends", async () => {
  const f = await fixture(true)
  try {
    await clickTimeline(f.page, 250)
    await assertPassageAtTop(f.page, 250)
    const stream = f.page.locator('.message-stream[tabindex]')
    await stream.evaluate(element => { element.scrollTop = element.scrollHeight })
    await f.page.waitForTimeout(500)
    await f.page.getByRole('button', { name: /Scroll to latest message|Aller au dernier message/ }).click()
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().window.kind === 'latest')
    await f.page.waitForTimeout(400)
    assert(await stream.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop < 2))
    await f.page.getByRole('button', { name: /Scroll to first message|Aller au premier message/ }).click()
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids[0] === 'msg_00000')
    await assertPassageAtTop(f.page, 0)
    const selected = f.page.locator('.message-timeline [aria-current="true"]')
    await selected.waitFor()
    assert.equal(await selected.getAttribute('data-message-id'), 'msg_00000')
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("keyboard scrolling owns the timeline without paging the transcript", async () => {
  const f = await fixture(true)
  try {
    const rail = f.page.locator('.message-timeline')
    await rail.focus()
    await rail.press('Home')
    await f.page.waitForTimeout(400)
    assert.equal(await rail.evaluate(element => element.scrollTop), 0)
    await rail.press('End')
    await f.page.waitForTimeout(400)
    assert(await rail.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop < 2))
    assert.equal(f.windows.length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("timeline uses the standard scrollbar and only rectangle width changes in RTL and fractional zoom", async () => {
  const f = await fixture()
  try {
    const rail = f.page.locator(".message-timeline")
    for (const direction of ["ltr", "rtl"]) for (const zoom of [1, 1.25]) {
      await f.page.evaluate(({ direction, zoom }) => { document.documentElement.dir = direction; document.body.style.zoom = String(zoom) }, { direction, zoom })
      const measure = () => rail.evaluate(element => {
        const style = getComputedStyle(element)
        return { width: element.clientWidth, gutter: element.offsetWidth - element.clientWidth, scrollbar: style.scrollbarWidth,
          segment: element.querySelector(".message-timeline-segment[data-message-id]")!.getBoundingClientRect().width,
          height: element.querySelector(".message-timeline-segment[data-message-id]")!.getBoundingClientRect().height,
          icon: element.querySelector(".message-timeline-icon")!.getBoundingClientRect().width }
      })
      const normal = await measure()
      assert.notEqual(normal.scrollbar, "none")
      const standard = await f.page.locator('.message-stream[tabindex]').evaluate(element => ({
        gutter: element.offsetWidth - element.clientWidth, scrollbar: getComputedStyle(element).scrollbarWidth,
      }))
      assert.equal(normal.gutter, standard.gutter)
      assert.equal(normal.scrollbar, standard.scrollbar)
      await rail.hover()
      const hover = await measure()
      assert.equal(hover.width, normal.width)
      assert.equal(hover.segment, normal.segment)
      assert.equal(hover.height, normal.height)
      assert.equal(hover.icon, normal.icon)
      await rail.locator("button[data-message-id]").first().focus()
      assert.equal((await measure()).width, normal.width)
      await rail.evaluate(element => { element.style.scrollbarGutter = "auto"; element.style.setProperty("scrollbar-width", "none", "important") })
      const withoutGutter = await measure()
      assert(withoutGutter.segment > normal.segment, "only the surrounding rectangle gives up width to the gutter")
      assert.equal(withoutGutter.icon, normal.icon, "icons never scale to fit the narrower rail")
      assert.equal(withoutGutter.height, normal.height, "vertical geometry does not scale with width")
      await rail.evaluate(element => { element.style.removeProperty("scrollbar-gutter"); element.style.removeProperty("scrollbar-width") })
    }
  } finally { await f.close() }
})

test("native timeline thumb follows the pointer without moving the transcript or snapping back during streaming", async () => {
  const f = await fixture(true)
  try {
    const before = await snapshot(f.page)
    await dragNativeThumb(f.page, '.message-timeline', 0.5)
    await f.page.waitForTimeout(400)
    const read = () => f.page.locator('.message-timeline').evaluate(element => ({
      top: element.scrollTop, extent: element.scrollHeight,
      ratio: element.scrollTop / (element.scrollHeight - element.clientHeight),
    }))
    const middle = await read()
    assert(Math.abs(middle.ratio - 0.5) < 0.02, JSON.stringify(middle))
    await f.page.evaluate(() => (window as any).fixture.stream('Live token while browsing the rail.'))
    await f.page.waitForTimeout(400)
    assert(Math.abs((await read()).top - middle.top) < 2, 'new transcript content must not reclaim the rail')
    assert.equal((await snapshot(f.page)).window.kind, before.window.kind)
    assert.equal(f.windows.length, 0, 'dragging the rail must not page the transcript')
    assert.deepEqual(f.errors, [])
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
