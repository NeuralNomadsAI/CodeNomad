import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { readNavigationWindow, readSessionOutline } from "../../../server/src/opencode/session-pruning/navigation-store"
import { readOutlinePreviews } from "../../../server/src/opencode/session-pruning/outline-preview"
import { navigationMessage, navigationMessageId, mixedNavigationMessage, deepNavigationMessage } from "./fixtures/history-navigation-data"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, cacheDir: cache.cacheDir, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
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
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })

async function fixture(mixed = false, pausePreviews = false, holdMessages = false, deep = false) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "codenomad-outline-browser-"))
  const databasePath = path.join(databaseDirectory, "history.sqlite")
  const db = new DatabaseSync(databasePath)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_updated INTEGER DEFAULT 0);
    CREATE UNIQUE INDEX seq_idx ON session_message(session_id,seq);
    INSERT INTO session_v2 VALUES ('s','/fixture','p',NULL,NULL);`)
  const insert = db.prepare("INSERT INTO session_message(id,session_id,type,seq,data) VALUES (?,'s',?,?,?)")
  for (let index = 0; index < 1500; index++) {
    const { id, type, ...data } = (mixed ? mixedNavigationMessage : deep ? deepNavigationMessage : navigationMessage)(index)
    insert.run(id, type, index, JSON.stringify(data))
  }
  if (mixed) {
    for (const [index, name] of [[6, "read"], [11, "glob"]] as const) {
      const { id, type: _, ...data } = mixedNavigationMessage(index)
      data.content.find((part: any) => part.type === "tool").name = name
      db.prepare("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify(data), id)
    }
  }
  for (let index = 0; index < 6; index++) {
    db.prepare("INSERT INTO session_v2 VALUES (?,'/fixture','p',NULL,NULL)").run(`cached-${index}`)
    db.prepare("INSERT INTO session_message(id,session_id,type,seq,data) VALUES (?,?,'user',0,?)").run(`cached-message-${index}`, `cached-${index}`, JSON.stringify({ text: "Cached index" }))
  }
  const errors: string[] = [], windows: any[] = []
  const outlines: Array<number | undefined> = []
  const previewRequests: string[][] = []
  const outlineReplies: any[] = []
  let resumeOutline!: () => void
  const outlineGate = new Promise<void>(resolve => { resumeOutline = resolve })
  const reads = new Set<Promise<unknown>>()
  let indexGate: Promise<void> | undefined, releaseIndex: (() => void) | undefined
  let hold: { messageID: string; release: () => void; promise: Promise<void> } | undefined
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", async route => {
    const request = route.request(), method = request.url().split("/").at(-1)
    if (new URL(request.url()).pathname.endsWith("/permission-receipts")) {
      return route.fulfill({ contentType: "application/json", body: '{"receipts":[]}' })
    }
    if (!request.url().includes("/session-history/") || !["outline", "outlinePreview", "window"].includes(method!)) {
      return route.fulfill({ contentType: "application/json", body: "{}" })
    }
    const input = request.postDataJSON()
    if (method === 'outline') {
      outlines.push(input.cursor?.after ?? input.after)
    }
    if (method === 'outlinePreview') {
      previewRequests.push(input.messageIDs)
      if (pausePreviews) await outlineGate
    }
    const scope = { directory: "/fixture", projectID: "p", sessionID: input.sessionID }
    // Production opens an independent read-only connection for every RPC.
    // Sharing one handle falsely nests yielding index/window transactions.
    const reader = new DatabaseSync(databasePath, { readOnly: true })
    const read = method === "window"
      ? readNavigationWindow(reader, scope, input.target, new AbortController().signal)
      : method === "outlinePreview" ? readOutlinePreviews(reader, scope, input.messageIDs, new AbortController().signal)
        : readSessionOutline(reader, scope, input.cursor, new AbortController().signal, input.after, input.known)
    reads.add(read)
    const response = await read.finally(() => { reads.delete(read); reader.close() })
    if (method === "outline") { outlineReplies.push(response); await indexGate }
    if (method === "window") {
      windows.push(input.target)
      if (input.target.messageID === hold?.messageID) await hold!.promise
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) }).catch(() => {})
  })
  await page.goto(url + `?${mixed ? "mixed&" : ""}${deep ? "deep&" : ""}${holdMessages ? "holdMessages" : ""}`)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  // The deep fixture's tool rows contribute extra segments.
  if (deep) await page.waitForFunction(() => Number(document.querySelector(".message-timeline")?.getAttribute("data-segment-count")) >= 1500)
  else await page.locator('.message-timeline[data-segment-count="1500"]').waitFor()
  if (!holdMessages) await page.waitForFunction(() => (window as any).fixture.snapshot().ids.length === 200)
  return { page, windows, errors, outlines, outlineReplies, previewRequests, resumeOutline,
    holdIndex: () => { indexGate = new Promise<void>(resolve => { releaseIndex = resolve }); return () => { releaseIndex?.(); indexGate = undefined } },
    offlineEdit: () => {
      db.prepare("DELETE FROM session_message WHERE id=?").run(navigationMessageId(250))
      db.prepare("UPDATE session_message SET type='assistant',data=?,time_updated=1 WHERE id=?").run(
        JSON.stringify({ content: [{ type: 'text', text: 'Updated' }, { type: 'tool', name: 'read' }] }), navigationMessageId(260))
      const { id, type, ...data } = navigationMessage(1500)
      insert.run(id, type, 1500, JSON.stringify(data))
    },
    hold: (index: number) => {
      let release!: () => void
      const promise = new Promise<void>(done => { release = done })
      hold = { messageID: navigationMessageId(index), release, promise }
      return release
    },
    close: async () => { hold?.release(); releaseIndex?.(); resumeOutline(); await page.close(); await Promise.allSettled(reads); db.close(); await rm(databaseDirectory, { recursive: true, force: true }) },
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

for (const evict of [false, true]) test(`missing saved anchor recovers once on session return (${evict ? 'evicted' : 'resident'})`, async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(evict => {
      ;(window as any).fixture.switchAway()
      ;(window as any).fixture.missingSavedAnchor(evict)
      ;(window as any).fixture.return()
    }, evict)
    await f.page.waitForFunction(() => {
      const s = (window as any).fixture.snapshot()
      return s.scroll?.atBottom && s.scroll?.anchorKey !== 'msg_removed' && s.ids.includes((window as any).fixture.id(1499))
    })
    assert.equal(f.windows.filter(w => w.messageID === 'msg_removed').length, 1)
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.waitForTimeout(400)
    assert.equal(f.windows.filter(w => w.messageID === 'msg_removed').length, 1, 'dead anchor must be retired, including saved window cursor')
    assert.equal(await f.page.getByRole('button', { name: /^(Reload messages|Recharger les messages)$/ }).count(), 0)
  } finally { await f.close() }
})

test("restoration ownership conflicts retain the saved passage instead of falling back", async () => {
  const f = await fixture()
  try {
    let conflicts = 0
    await f.page.route('**/session-history/window', route => { conflicts++; return route.fulfill({ json: { status: 'blocked', reason: 'conflict' } }) })
    await f.page.evaluate(() => {
      ;(window as any).fixture.switchAway()
      ;(window as any).fixture.missingSavedAnchor(false)
      ;(window as any).fixture.return()
    })
    await f.page.getByRole('button', { name: /^(Reload messages|Recharger les messages)$/ }).first().waitFor()
    assert.equal(conflicts, 1, JSON.stringify({ snapshot: await snapshot(f.page), windows: f.windows, errors: f.errors }))
    const failed = await snapshot(f.page)
    assert.equal(failed.scroll.anchorKey, 'msg_removed', 'conflict must preserve the reading destination')
    assert.equal(failed.scroll.atBottom, false, 'only a confirmed missing anchor may reset to latest')
    await f.page.waitForTimeout(300)
    assert.equal((await snapshot(f.page)).nativeLists, failed.nativeLists, 'conflict must not start a retry loop')
  } finally { await f.close() }
})

test("index and exact scrollbar precede transcript and previews, and survive session returns", async () => {
  const f = await fixture(false, true, true)
  try {
    const rail = f.page.locator('.message-timeline')
    const height = await rail.evaluate(element => element.scrollHeight)
    assert.equal((await snapshot(f.page)).ids.length, 0, 'index must not wait for transcript hydration')
    assert.equal(await f.page.locator('.history-navigation-status').count(), 0, 'no outline countdown')
    await rail.hover()
    await rail.evaluate(element => { element.scrollTop = element.scrollHeight / 6 })
    await rail.locator('[data-message-id="msg_00250"]').hover()
    await f.page.waitForTimeout(350)
    assert.equal(await f.page.getByRole('tooltip').count(), 0, 'unloaded preview has no empty popup')
    f.resumeOutline()
    await f.page.getByRole('tooltip').waitFor()
    assert.equal(await rail.evaluate(element => element.scrollHeight), height, 'preview arrival cannot resize the scrollbar')
    await f.page.evaluate(() => (window as any).fixture.releaseMessages())
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids.length === 200)
    const hydratedScans = f.outlines.length
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.locator('.message-timeline[data-segment-count="1500"]').waitFor()
    assert.equal(f.outlines.length, hydratedScans, `return reuses the structural index: ${JSON.stringify(f.outlines)}`)
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

test("indexes survive more than four session visits and live refresh reads only the tail", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await f.page.evaluate(() => (window as any).fixture.visitIndexes())
    const count = f.outlines.length
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.locator('.message-timeline[data-segment-count="1500"]').waitFor()
    await f.page.waitForTimeout(250)
    assert.equal(f.outlines.length, count, 'six other indexes must not evict the original')
    await f.page.evaluate(() => {
      ;(window as any).fixture.stream('A new message')
      ;(window as any).fixture.status('working')
    })
    await f.page.waitForFunction(() => document.querySelector('.message-timeline')?.getAttribute('data-segment-count') === '1501')
    await f.page.waitForTimeout(200)
    assert.equal(f.outlineReplies.at(-1).entries.length, 476, 'refresh only returns the last changed checkpoint')
    assert.equal(f.outlineReplies.at(-1).checkpoints.filter((checkpoint: any) => !checkpoint.changed).length, 2)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("restored partition index paints before revalidation and applies offline changes by checkpoint", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.saveIndexes())
    f.offlineEdit()
    const release = f.holdIndex()
    await f.page.reload()
    await f.page.waitForFunction(() => Boolean((window as any).fixture))
    await f.page.locator('.message-timeline[data-segment-count="1500"]').waitFor()
    assert((await f.page.evaluate(() => (window as any).fixture.index())).entries.some((entry: any) => entry.id === 'msg_00250'),
      'saved geometry is visible while native verification is blocked')
    release()
    await f.page.waitForFunction(() => {
      const entries = (window as any).fixture.index()?.entries ?? []
      return !entries.some((entry: any) => entry.id === 'msg_00250') && entries.some((entry: any) => entry.id === 'msg_01500')
    })
    const response = f.outlineReplies.at(-1)
    assert.equal(response.entries.length, 988, 'only changed ranges travel back to the renderer')
    assert.equal(response.checkpoints.filter((checkpoint: any) => !checkpoint.changed).length, 1)
    assert.equal(response.entries.find((entry: any) => entry.id === 'msg_00260').tools, 1)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("restored index from another project is not displayed", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.saveIndexes('foreign'))
    const release = f.holdIndex()
    await f.page.reload()
    await f.page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await f.page.locator('.message-timeline[data-segment-count="1500"]').count(), 0)
    release()
    await f.page.locator('.message-timeline[data-segment-count="1500"]').waitFor()
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

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

// A jump's page commit stores its intended position before the list reaches
// it. Cancelling after that commit must store the reader's actual position at
// once, not only after a later scroll event happens to persist it. Right after
// the commit the remounted list can sit at the bottom of its estimated content;
// a capture there carries no anchor, so it must match the DOM offset instead,
// and must not inherit the commit's intended anchor.
test("cancelling a committed timeline jump stores the reader's actual position", async () => {
  const f = await fixture()
  const readStoredPosition = `(() => {
    const scroll = { ...window.fixture.snapshot().scroll }
    const stream = document.querySelector('.message-stream')
    const row = stream.querySelector('[data-virtual-follow-key="' + scroll.anchorKey + '"]')
    return { scroll, offset: row ? row.getBoundingClientRect().top - stream.getBoundingClientRect().top : null,
      domScrollTop: stream.scrollTop, domAtBottom: stream.scrollHeight - stream.clientHeight - stream.scrollTop <= 1 }
  })()`
  try {
    // This is the restored list's case: let the startup restore settle first
    // (its persisted capture is the first snapshot carrying the list's extent).
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().scroll?.maxScrollTop !== undefined)
    await f.page.evaluate(`(async () => {
      const { messageStoreBus } = await import('/src/stores/message-v2/bus.ts')
      const stop = messageStoreBus.onScrollSnapshotChanged((_instance, _session, _scope, snapshot) => {
        if (snapshot.anchorKey !== ${JSON.stringify(navigationMessageId(250))}) return
        stop()
        queueMicrotask(() => {
          document.querySelector('.history-navigation-status button').click()
          window.cancelledPosition = ${readStoredPosition}
        })
      })
    })()`)
    await clickTimeline(f.page, 250)
    await f.page.waitForFunction(() => Boolean((window as any).cancelledPosition))
    await f.page.locator(".history-navigation-status").waitFor({ state: "hidden" })
    await f.page.evaluate(`new Promise(resolve => { let count = 30; const next = () => --count ? requestAnimationFrame(next) : resolve(); requestAnimationFrame(next) })`)
    // The list keeps moving after the cancel; that movement is recorded when the
    // scroll settles (Virtua's scroll end, 150-300 ms after the last event).
    await f.page.waitForFunction(`(() => { const state = ${readStoredPosition}; return state.offset !== null && Math.abs(state.offset - state.scroll.anchorOffset) < 4 })()`, undefined, { timeout: 3000 })
    const states = { cancelled: await f.page.evaluate(() => (window as any).cancelledPosition), settled: await f.page.evaluate(readStoredPosition) }
    for (const [when, state] of Object.entries(states)) {
      const actual = state.scroll.anchorKey !== undefined
        ? state.offset !== null && Math.abs(state.offset - state.scroll.anchorOffset) < 4
        : state.scroll.atBottom && state.domAtBottom && Math.abs(state.scroll.scrollTop - state.domScrollTop) < 2
      assert.ok(actual, `Stored position (${when}) is not the reader's: ${JSON.stringify(state)}`)
    }
    assert.ok(states.settled.scroll.anchorKey !== undefined, `The settled reader must be anchored: ${JSON.stringify(states.settled)}`)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

const waitFrames = (page: Page, count = 30) => page.evaluate(`new Promise(resolve => { let count = ${count}; const next = () => --count ? requestAnimationFrame(next) : resolve(); requestAnimationFrame(next) })`)
const seedSavedPosition = (page: Page, anchorKey: string) => page.evaluate(`(async () => {
  const { messageStoreBus } = await import('/src/stores/message-v2/bus.ts')
  messageStoreBus.getOrCreate('navigation').setScrollSnapshot('s', 'message-stream', { scrollTop: 100, atBottom: false,
    anchorKey: ${JSON.stringify(anchorKey)}, anchorOffset: 0, followModeType: 'escaped', windowIsLatest: true })
})()`)
/** The active search occurrence relative to the transcript viewport. */
const activeOccurrence = (page: Page) => page.evaluate(`(() => {
  const range = [...(CSS.highlights.get('codenomad-search-active') ?? [])][0]
  const stream = document.querySelector('.message-stream'), bounds = stream.getBoundingClientRect()
  if (!range) return null
  const rect = range.getBoundingClientRect()
  return { text: range.toString(), top: rect.top - bounds.top, bottom: rect.bottom - bounds.top, viewport: stream.clientHeight }
})()`) as Promise<{ text: string; top: number; bottom: number; viewport: number } | null>
const rowOffset = (page: Page, index: number) => page.evaluate(`(() => {
  const stream = document.querySelector('.message-stream'), row = stream.querySelector('[data-virtual-follow-key="${navigationMessageId(index)}"]')
  return row ? row.getBoundingClientRect().top - stream.getBoundingClientRect().top : null
})()`) as Promise<number | null>

// The timeline is usable before the transcript hydrates. A jump cancelled
// before it positions anything must leave the activation restore pending.
test("a jump cancelled before hydration still restores the saved passage", async () => {
  const f = await fixture(false, false, true)
  try {
    await seedSavedPosition(f.page, navigationMessageId(1450))
    const release = f.hold(250)
    await clickTimeline(f.page, 250)
    await f.page.locator(".history-navigation-status").waitFor()
    await f.page.locator(".history-navigation-status button").click()
    await f.page.locator(".history-navigation-status").waitFor({ state: "hidden" })
    release()
    await f.page.evaluate(() => (window as any).fixture.releaseMessages())
    await assertPassageAtTop(f.page, 1450)
    assert.equal((await snapshot(f.page)).scroll.anchorKey, navigationMessageId(1450))
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

// The page commit replaces the stored position and window with its
// destination. Once the jump is cancelled, the pending restore must still
// return to the saved position: a passage, the latest bottom, or (none saved)
// the latest bottom too, reopening the latest window the commit replaced.
for (const saved of ["passage", "latest bottom", "none"] as const) test(`a jump cancelled after its page commit, before hydration, still restores the saved position (${saved})`, async () => {
  const f = await fixture(false, false, true)
  try {
    if (saved === "passage") await seedSavedPosition(f.page, navigationMessageId(1450))
    if (saved === "latest bottom") await f.page.evaluate(`(async () => {
      const { messageStoreBus } = await import('/src/stores/message-v2/bus.ts')
      messageStoreBus.getOrCreate('navigation').setScrollSnapshot('s', 'message-stream', { scrollTop: 100, atBottom: true, followModeType: 'following', windowIsLatest: true })
    })()`)
    await f.page.evaluate(`(async () => {
      const { messageStoreBus } = await import('/src/stores/message-v2/bus.ts')
      const stop = messageStoreBus.onScrollSnapshotChanged((_instance, _session, _scope, snapshot) => {
        if (snapshot.anchorKey !== ${JSON.stringify(navigationMessageId(250))}) return
        stop()
        queueMicrotask(() => document.querySelector('.history-navigation-status button').click())
      })
    })()`)
    await clickTimeline(f.page, 250)
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().window?.kind === "history")
    await f.page.locator(".history-navigation-status").waitFor({ state: "hidden" })
    await f.page.evaluate(() => (window as any).fixture.releaseMessages())
    if (saved === "passage") {
      await assertPassageAtTop(f.page, 1450)
      assert.equal((await snapshot(f.page)).scroll.anchorKey, navigationMessageId(1450))
    } else {
      await f.page.waitForFunction(() => {
        const state = (window as any).fixture.snapshot()
        const stream = document.querySelector(".message-stream")!
        return state.window?.kind === "latest" && state.ids.includes("msg_01499")
          && stream.scrollHeight - stream.clientHeight - stream.scrollTop <= 1
      })
      await waitFrames(f.page, 30)
      const state = await snapshot(f.page)
      assert.equal(state.window.kind, "latest", "the latest window must replace the cancelled one")
      assert.ok(state.scroll.atBottom && state.scroll.windowIsLatest, `the stored position must be the latest bottom: ${JSON.stringify(state.scroll)}`)
      assert.ok(await f.page.locator('.message-stream [data-virtual-follow-key="msg_01499"]').count(), "the latest message must be shown")
    }
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

// A send pins the latest bottom itself: sent before hydration, it supersedes the
// activation restore still pending for a saved passage, which must not run later.
test("a message sent before hydration stays at the bottom over a saved passage", async () => {
  const f = await fixture(false, false, true)
  try {
    await seedSavedPosition(f.page, navigationMessageId(1450))
    await f.page.locator(".prompt-input-container textarea").first().fill("Sent before hydration")
    await f.page.locator(".send-button").click()
    await f.page.waitForFunction(() => (window as any).fixture.prompts().length === 1)
    await f.page.evaluate(() => (window as any).fixture.releaseMessages())
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids.includes("msg_01499"))
    await waitFrames(f.page, 60)
    const sentId = await f.page.evaluate(() => (window as any).fixture.prompts()[0])
    const state = await f.page.evaluate(`(() => {
      const stream = document.querySelector('.message-stream'), bounds = stream.getBoundingClientRect()
      const row = stream.querySelector('[data-virtual-follow-key="${sentId}"]')?.getBoundingClientRect()
      return { row: row ? { top: row.top - bounds.top, bottom: row.bottom - bounds.top } : null, viewport: stream.clientHeight,
        atBottom: stream.scrollHeight - stream.clientHeight - stream.scrollTop <= 1, anchorKey: window.fixture.snapshot().scroll?.anchorKey }
    })()`) as { row: { top: number; bottom: number } | null; viewport: number; atBottom: boolean; anchorKey?: string }
    assert.ok(state.row && state.row.top >= 0 && state.row.bottom <= state.viewport + 1 && state.atBottom,
      `the sent message must stay visible at the bottom: ${JSON.stringify(state)}`)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

const bottomState = (page: Page) => page.evaluate(`(() => {
  const stream = document.querySelector('.message-stream')
  return { mode: stream.getAttribute('data-follow-mode'), gap: stream.scrollHeight - stream.clientHeight - stream.scrollTop }
})()`) as Promise<{ mode: string | null; gap: number }>

// A send pins the bottom until its exchange settles. The click projects the
// sent row synchronously, after the pin's first write; a switch before the
// pin's next frame must still capture following at the bottom, not escaped.
test("switching sessions right after a send returns following at the bottom", async () => {
  const f = await fixture()
  try {
    await waitFrames(f.page, 30)
    assert.deepEqual(await bottomState(f.page), { mode: "following", gap: 0 }, "the hydrated session starts following at the bottom")
    await f.page.locator(".prompt-input-container textarea").first().fill("Sent before switching")
    const switched = await f.page.evaluate(`(() => {
      document.querySelector('.send-button').click()
      const stream = document.querySelector('.message-stream')
      const state = { gap: stream.scrollHeight - stream.clientHeight - stream.scrollTop,
        sent: window.fixture.snapshot().ids.filter(id => !/^msg_\\d{5}$/.test(id)).length }
      window.fixture.switchAway()
      return state
    })()`) as { gap: number; sent: number }
    assert.equal(switched.sent, 1, `the send (and its pin) must be under way at the switch: ${JSON.stringify(switched)}`)
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.waitForFunction(() => document.querySelector(".message-stream [data-virtual-follow-key]"))
    await waitFrames(f.page, 60)
    const returned = await bottomState(f.page)
    assert.ok(returned.mode === "following" && returned.gap <= 1,
      `the returned session must follow at the bottom: ${JSON.stringify({ switched, returned, scroll: (await snapshot(f.page)).scroll })}`)
    await f.page.evaluate(() => (window as any).fixture.stream("A reply that grows after the return. ".repeat(80)))
    await waitFrames(f.page, 30)
    const grown = await bottomState(f.page)
    assert.ok(grown.mode === "following" && grown.gap <= 1, `later growth must be followed: ${JSON.stringify(grown)}`)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

/** Samples a row's viewport offset on each frame from now, while `gesture` runs. */
async function sampleRowOffsets(page: Page, index: number, frames: number, gesture: () => Promise<void>) {
  await page.evaluate(`(() => {
    const stream = document.querySelector('.message-stream'), samples = window.rowSamples = []
    let count = ${frames}
    const next = () => {
      const row = stream.querySelector('[data-virtual-follow-key="${navigationMessageId(index)}"]')
      samples.push(row ? row.getBoundingClientRect().top - stream.getBoundingClientRect().top : null)
      if (--count) requestAnimationFrame(next)
    }
    requestAnimationFrame(next)
  })()`)
  await gesture()
  await page.waitForFunction(frames => (window as any).rowSamples.length >= frames, frames)
  return page.evaluate(() => (window as any).rowSamples) as Promise<Array<number | null>>
}

/**
 * Records every `data-scroll-write` value of the transcript from now on into
 * `window.scrollWrites`, so a short-lived write reason cannot be missed.
 */
const recordScrollWrites = (page: Page) => page.evaluate(() => {
  const element = document.querySelector(".message-stream")!, seen: Array<string | null> = (window as any).scrollWrites = []
  new MutationObserver(records => {
    // Each record's new value is the next one's old value, the last is current.
    for (const [index, record] of records.entries()) if (index) seen.push(record.oldValue)
    seen.push(element.getAttribute("data-scroll-write"))
  }).observe(element, { attributeFilter: ["data-scroll-write"], attributeOldValue: true })
})
const sawScrollWrite = (page: Page, reason: string) =>
  page.waitForFunction(reason => (window as any).scrollWrites.includes(reason), reason)

// A resident jump writes its row's offset to the DOM, then holds that row while
// rows keep mounting. A gesture right after the click, before the jump settles,
// must win at once and for good.
for (const gesture of ["wheel", "PageUp"] as const) test(`a ${gesture} right after a resident timeline jump wins over the jump`, async () => {
  const f = await fixture()
  try {
    await waitFrames(f.page, 30)
    await f.page.evaluate(() => (window as any).codenomadLogger.enableLogger("scroll"))
    const stream = f.page.locator(".message-stream[tabindex]")
    const box = (await stream.boundingBox())!
    const amplitude = gesture === "wheel" ? 300 : await stream.evaluate(element => element.clientHeight * 0.875)
    await recordScrollWrites(f.page)
    await clickTimeline(f.page, 1350)
    // The click has written its jump; its landing has not settled.
    await sawScrollWrite(f.page, "jump-key")
    await waitFrames(f.page, 2)
    const samples = await sampleRowOffsets(f.page, 1350, 90, async () => {
      if (gesture === "wheel") {
        await f.page.mouse.move(box.x + 60, box.y + box.height / 2)
        await f.page.mouse.wheel(0, -300)
      } else {
        await stream.evaluate(element => element.focus({ preventScroll: true }))
        await f.page.keyboard.press("PageUp")
      }
    })
    // The jump's target puts the row at the top (offset 0); the gesture moves it down.
    const won = samples.findIndex(offset => offset !== null && offset >= amplitude / 2)
    const detail = JSON.stringify({ amplitude, samples: samples.map(offset => offset === null ? null : Math.round(offset)) })
    assert.ok(won >= 0 && won < 30, `the ${gesture} must win within 30 frames: ${detail}`)
    const reverted = samples.slice(won).findIndex(offset => offset !== null && offset < amplitude / 4)
    assert.equal(reverted, -1, `the jump must not reclaim its target after the ${gesture}: ${detail}`)
    await waitFrames(f.page, 30)
    const settled = await rowOffset(f.page, 1350)
    assert.ok(settled === null || settled >= amplitude / 2, `the ${gesture} must hold: ${settled} ${detail}`)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

/** Grows the streaming reply by a paragraph on every frame until `window.tailStreaming` is cleared. */
const streamTail = (page: Page) => page.evaluate(`(() => {
  window.tailStreaming = true
  const next = () => {
    if (!window.tailStreaming) return
    window.fixture.stream("\\n\\nA streamed paragraph that grows the live reply.")
    requestAnimationFrame(next)
  }
  requestAnimationFrame(next)
})()`)

// During streaming a Virtua operation would live on every measurement and
// reassert its target over a wheel; a resident jump's landing must leave none,
// so a wheel right after it wins for good while the tail keeps growing.
test("a wheel right after a resident timeline jump during streaming wins for good", async () => {
  const f = await fixture()
  try {
    await waitFrames(f.page, 30)
    await f.page.evaluate(() => (window as any).codenomadLogger.enableLogger("scroll"))
    await f.page.evaluate(() => (window as any).fixture.status("working"))
    await streamTail(f.page)
    await waitFrames(f.page, 30)
    const rail = f.page.locator(".message-timeline")
    await rail.hover()
    await rail.evaluate(element => { element.scrollTop = element.scrollHeight * 1350 / 1500 })
    await f.page.locator(`.message-timeline-segment[data-message-id="${navigationMessageId(1350)}"]`).waitFor()
    const box = (await f.page.locator(".message-stream[tabindex]").boundingBox())!
    await f.page.mouse.move(box.x + 60, box.y + box.height / 2)
    await recordScrollWrites(f.page)
    // Pause the stream 100 ms before the jump, so the jump's write outlives the
    // last measurement by that much.
    await f.page.evaluate(`new Promise(resolve => {
      window.tailStreaming = false
      setTimeout(() => { document.querySelector('.message-timeline-segment[data-message-id="${navigationMessageId(1350)}"]').click(); resolve() }, 100)
    })`)
    await sawScrollWrite(f.page, "jump-key")
    // The wheel comes more than 150 ms after that measurement, within 150 ms of
    // the jump; the stream resumes at once.
    await f.page.waitForTimeout(80)
    const samples = await sampleRowOffsets(f.page, 1350, 90, async () => {
      await f.page.mouse.wheel(0, -300)
      await streamTail(f.page)
    })
    const detail = JSON.stringify({ samples: samples.map(offset => offset === null ? null : Math.round(offset)) })
    const won = samples.findIndex(offset => offset !== null && offset >= 150)
    assert.ok(won >= 0 && won < 30, `the wheel must win within 30 frames: ${detail}`)
    const reverted = samples.slice(won).findIndex(offset => offset !== null && offset < 150)
    assert.equal(reverted, -1, `the stream must not restore the jump's offset after the wheel: ${detail}`)
    assert.ok((await snapshot(f.page)).ids.includes("msg_streaming"), "the reply streamed throughout")
    assert.deepEqual(f.errors, [])
  } finally {
    await f.page.evaluate(() => { (window as any).tailStreaming = false }).catch(() => {})
    await f.close()
  }
})

// A settled jump leaves the reader in charge: a later programmatic scroll or
// a focus move (keyboard, assistive technology) must keep its new position.
for (const move of ["scrollIntoView", "focus"] as const) test(`a ${move} after a settled resident timeline jump keeps its position`, async () => {
  const f = await fixture()
  try {
    await clickTimeline(f.page, 1350)
    await assertPassageAtTop(f.page, 1350)
    await waitFrames(f.page, 90)
    // Row 1356 lies just below the viewport, mounted in the overscan.
    const moved = await f.page.evaluate(`(() => {
      const stream = document.querySelector('.message-stream'), row = stream.querySelector('[data-virtual-follow-key="${navigationMessageId(1356)}"]')
      const before = stream.scrollTop
      if (${JSON.stringify(move)} === 'scrollIntoView') row.scrollIntoView()
      else row.querySelector('button').focus()
      return { delta: stream.scrollTop - before, offset: row.getBoundingClientRect().top - stream.getBoundingClientRect().top }
    })()`) as { delta: number; offset: number }
    assert.ok(moved.delta > 0, `the ${move} must scroll the transcript: ${JSON.stringify(moved)}`)
    await waitFrames(f.page, 60)
    const offsets = { moved, row1356: await rowOffset(f.page, 1356), row1350: await rowOffset(f.page, 1350) }
    assert.ok(offsets.row1356 !== null && Math.abs(offsets.row1356 - moved.offset) < 2,
      `the jump's anchor must not pull back the ${move}: ${JSON.stringify(offsets)}`)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

// A restore loading its saved anchor positions the list itself: reaching the
// bottom meanwhile must not page beyond the window that restore brings in.
test("reaching the bottom while a restore loads its anchor does not page newer", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await seedSavedPosition(f.page, navigationMessageId(250))
    const release = f.hold(250)
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.waitForFunction(() => document.querySelector(".message-stream [data-virtual-follow-key]"))
    for (let i = 0; i < 100 && !f.windows.some(target => target.messageID === navigationMessageId(250)); i++) await waitFrames(f.page, 3)
    const box = (await f.page.locator(".message-stream").boundingBox())!
    await f.page.mouse.move(box.x + 60, box.y + box.height / 2)
    // The anchor arrives about 500 ms later, while that downward intent is
    // still fresh (600 ms), so its window swap is observed as reaching the bottom.
    await f.page.mouse.wheel(0, 1000000)
    await waitFrames(f.page, 30)
    release()
    await assertPassageAtTop(f.page, 250)
    await waitFrames(f.page, 30)
    assert.deepEqual(f.windows.map(target => target.messageID), [navigationMessageId(250)], "no newer page may be requested")
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

// A gesture that cancels a pending jump over a visible list leaves the reader
// in charge: the restore must not run again under it.
test("a gesture cancelling a jump over a visible list does not rerun the restore", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await seedSavedPosition(f.page, navigationMessageId(250))
    const releaseSaved = f.hold(250)
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.waitForFunction(() => document.querySelector(".message-stream [data-virtual-follow-key]"))
    for (let i = 0; i < 100 && !f.windows.some(target => target.messageID === navigationMessageId(250)); i++) await waitFrames(f.page, 3)
    const releaseJump = f.hold(900)
    await clickTimeline(f.page, 900)
    await f.page.locator(".history-navigation-status").waitFor()
    const box = (await f.page.locator(".message-stream").boundingBox())!
    await f.page.mouse.move(box.x + 60, box.y + box.height / 2)
    await f.page.mouse.wheel(0, -300)
    await f.page.locator(".history-navigation-status").waitFor({ state: "hidden" })
    releaseJump()
    releaseSaved()
    await waitFrames(f.page, 60)
    assert.deepEqual(f.windows.map(target => target.messageID), [navigationMessageId(250), navigationMessageId(900)], "the restore must not run again")
    assert.ok(!(await snapshot(f.page)).ids.includes(navigationMessageId(250)), "the reader must stay on the visible list")
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

// A restore still loading its saved anchor yields to paging the reader starts:
// the late anchor never moves the paged passage.
test("paging supersedes a restore that is loading its anchor", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await seedSavedPosition(f.page, navigationMessageId(250))
    const release = f.hold(250)
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.waitForFunction(() => document.querySelector(".message-stream"))
    await clickTimeline(f.page, 900)
    await assertPassageAtTop(f.page, 900)
    release()
    await waitFrames(f.page, 60)
    assert.ok(Math.abs((await rowOffset(f.page, 900))!) < 2, "the late restore anchor moved the paged passage")
    assert((await snapshot(f.page)).ids.includes(navigationMessageId(900)))
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

/** Unmounts the session in the first frame where `index` reaches the top, while its page load still owns the position. */
const switchAwayWhenAtTop = (page: Page, index: number) => page.evaluate(`new Promise(resolve => {
  const next = () => {
    const stream = document.querySelector('.message-stream')
    const row = stream?.querySelector('[data-virtual-follow-key="${navigationMessageId(index)}"]')
    if (row && Math.abs(row.getBoundingClientRect().top - stream.getBoundingClientRect().top) < 2) {
      window.fixture.switchAway()
      resolve()
    } else requestAnimationFrame(next)
  }
  requestAnimationFrame(next)
})`)

// Unmounting while a page load still owns a list it has positioned (or one
// awaiting an older page) must store where the reader is, not the position
// held before the load under the new window's cursor.
for (const via of ["timeline", "search"] as const) test(`unmounting right after a far ${via} jump lands stores the destination`, async () => {
  const f = await fixture()
  try {
    if (via === "search") {
      await f.page.route("**/session-history/query", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        status: "page", scanned: 1500, tools: 0, reasoning: 0, skipped: 0, candidates: [], cursor: null,
        hits: [{ sessionID: "s", messageID: navigationMessageId(250), role: "user", partIndex: 0, kind: "text", excerpt: "Passage 250" }],
      }) }))
      await f.page.evaluate(() => (window as any).fixture.openSearch())
      await f.page.getByRole("searchbox").fill("Passage")
      await f.page.locator(".history-search-result").first().waitFor()
      const landed = switchAwayWhenAtTop(f.page, 250)
      await f.page.locator(".history-search-result").first().click()
      await landed
    } else {
      const landed = switchAwayWhenAtTop(f.page, 250)
      await clickTimeline(f.page, 250)
      await landed
    }
    assert.equal((await snapshot(f.page)).scroll.anchorKey, navigationMessageId(250))
    await f.page.evaluate(() => (window as any).fixture.return())
    await assertPassageAtTop(f.page, 250)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("unmounting during a held older page stores the reader's position", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.holdNextList())
    const box = (await f.page.locator(".message-stream").boundingBox())!
    await f.page.mouse.move(box.x + 60, box.y + box.height / 2)
    await f.page.mouse.wheel(0, -1000000)
    // The older page is a native list read: it must be the held request.
    await f.page.waitForFunction(() => (window as any).fixture.listPending(), undefined, { timeout: 5000 })
    await waitFrames(f.page, 30)
    assert.ok(await f.page.evaluate(() => (window as any).fixture.listPending()), "the older page must still be held")
    assert.ok(Math.abs((await rowOffset(f.page, 1300))!) < 2, "the reader must be at the top of the latest page")
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    assert.equal((await snapshot(f.page)).scroll.anchorKey, navigationMessageId(1300))
    await f.page.evaluate(() => (window as any).fixture.releaseList())
    await waitFrames(f.page, 30)
    await f.page.evaluate(() => (window as any).fixture.return())
    await assertPassageAtTop(f.page, 1300)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

// A resident placement supersedes an unpositioned jump that was itself
// superseding the restore: the placement owns the position, so the restore
// must not run again and move the reader back to the saved passage.
test("a resident placement after an unpositioned jump is not overridden by the restore", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.switchAway())
    await seedSavedPosition(f.page, navigationMessageId(250))
    const releaseSaved = f.hold(250)
    await f.page.evaluate(() => (window as any).fixture.return())
    await f.page.waitForFunction(() => document.querySelector(".message-stream"))
    for (let i = 0; i < 100 && !f.windows.some(target => target.messageID === navigationMessageId(250)); i++) await waitFrames(f.page, 3)
    const releaseJump = f.hold(900)
    await clickTimeline(f.page, 900)
    await f.page.locator(".history-navigation-status").waitFor()
    await clickTimeline(f.page, 1400)
    releaseJump()
    releaseSaved()
    await assertPassageAtTop(f.page, 1400)
    await waitFrames(f.page, 30)
    assert.ok(Math.abs((await rowOffset(f.page, 1400))!) < 2, "the restore moved the placed passage")
    assert.deepEqual(f.windows.map(target => target.messageID), [navigationMessageId(250), navigationMessageId(900)], "the restore must not run again")
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

// Only a search navigation reveals its occurrence. A non-resident result that
// the reader pages into view by scrolling leaves the reader where paging put it.
test("a search result made resident by manual paging does not pull the reader", async () => {
  const f = await fixture()
  try {
    await f.page.route("**/session-history/query", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
      status: "page", scanned: 1500, tools: 0, reasoning: 0, skipped: 0, candidates: [], cursor: null,
      hits: [{ sessionID: "s", messageID: navigationMessageId(1290), role: "user", partIndex: 0, kind: "text", excerpt: "Passage 1290" }],
    }) }))
    await f.page.evaluate(() => (window as any).fixture.openSearch())
    await f.page.getByRole("searchbox").fill("Passage")
    await f.page.locator(".history-search-result").first().waitFor()
    await waitFrames(f.page)
    const box = (await f.page.locator(".message-stream").boundingBox())!
    await f.page.mouse.move(box.x + 60, box.y + box.height / 2)
    await f.page.mouse.wheel(0, -1000000)
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids.includes("msg_01290"))
    await waitFrames(f.page, 90)
    assert.ok(await rowOffset(f.page, 1290) !== null, "the active result must be mounted")
    const gap = await f.page.locator(".message-stream").evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
    assert.ok(gap <= 1, `an older page is entered at its bottom; the mounted result pulled the reader ${gap}px away`)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

/** Deep fixture positioned on 1300 with search open and `Deepword<index>` hits routed. */
async function deepSearch(index: number) {
  const f = await fixture(false, false, false, true)
  await f.page.route("**/session-history/query", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    status: "page", scanned: 1500, tools: 0, reasoning: 0, skipped: 0, candidates: [], cursor: null,
    hits: [{ sessionID: "s", messageID: navigationMessageId(index), role: "assistant", partIndex: 0, kind: "text", excerpt: `Deepword${index}` }],
  }) }))
  await clickTimeline(f.page, 1300)
  await assertPassageAtTop(f.page, 1300)
  await f.page.evaluate(() => (window as any).fixture.openSearch())
  return f
}
const assertOccurrenceVisible = async (page: Page, text: string) => {
  const occurrence = await activeOccurrence(page)
  assert.ok(occurrence && occurrence.text === text && occurrence.top >= 0 && occurrence.bottom <= occurrence.viewport,
    `the highlighted occurrence must be visible: ${JSON.stringify(occurrence)}`)
}

// A search navigation places its message at the top, then reveals an
// occurrence that placement leaves out of view, through the list's held
// alignment rather than a one-frame write its placement would undo. The
// virtualizer moves rows while a taller row below settles; the highlight
// must survive those moves.
for (const index of [1400, 600]) test(`a deep search occurrence is revealed and stays highlighted (${index === 1400 ? "resident" : "historical"})`, async () => {
  const f = await deepSearch(index)
  try {
    // Once revealed, no frame may lose the active highlight to a row move.
    await f.page.evaluate(`(() => {
      const frames = window.highlightFrames = []
      const sample = () => {
        const range = [...(CSS.highlights.get('codenomad-search-active') ?? [])][0]
        frames.push(range ? (range.collapsed ? 'collapsed' : range.toString()) : 'none')
        if (frames.length < 400) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })()`)
    await f.page.getByRole("searchbox").fill(`Deepword${index}`)
    // A resident first result is located automatically; a historical one on selection.
    if (index === 600) await f.page.locator(".history-search-result").first().click()
    await f.page.waitForFunction(id => (window as any).fixture.snapshot().ids.includes(id), navigationMessageId(index))
    await waitFrames(f.page, 90)
    await assertOccurrenceVisible(f.page, `Deepword${index}`)
    await waitFrames(f.page, 60)
    await assertOccurrenceVisible(f.page, `Deepword${index}`)
    const sampled: string[] = await f.page.evaluate("window.highlightFrames")
    const lost = sampled.slice(sampled.indexOf(`Deepword${index}`)).filter(frame => frame !== `Deepword${index}`)
    assert.deepEqual(lost, [], `the active highlight was lost in ${lost.length} frame(s)`)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

// Selecting the same result again reveals it again; a gesture made before the
// reveal's frame claims it, so the reader is never pulled.
for (const gesture of [false, true]) test(`re-selecting a deep result ${gesture ? "with an immediate gesture leaves the reader in place" : "reveals it again"}`, async () => {
  const f = await deepSearch(1400)
  const aligned: string[] = []
  f.page.on("console", message => { if (/scroll (?:%c)?write .*"reason":"align-element"/.test(message.text())) aligned.push(message.text()) })
  try {
    await f.page.getByRole("searchbox").fill("Deepword1400")
    await f.page.locator(".history-search-result").first().waitFor()
    await waitFrames(f.page, 90)
    await clickTimeline(f.page, 1300)
    await assertPassageAtTop(f.page, 1300)
    await f.page.evaluate(() => (window as any).codenomadLogger.enableLogger("scroll"))
    await f.page.evaluate(`(() => {
      document.querySelector('.history-search-result').click()
      if (${gesture}) document.querySelector('.message-stream').dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
    })()`)
    await waitFrames(f.page, 90)
    await f.page.evaluate(() => (window as any).codenomadLogger.disableLogger("scroll"))
    if (gesture) assert.deepEqual(aligned, [], "a claimed reveal must not align the transcript")
    else {
      assert.ok(aligned.length > 0, "the re-selection must reveal through the list")
      await assertOccurrenceVisible(f.page, "Deepword1400")
    }
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

// A shallow occurrence is already visible once its message is at the top.
test("a shallow search result lands at the top with its occurrence visible", async () => {
  const f = await fixture()
  try {
    await f.page.route("**/session-history/query", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
      status: "page", scanned: 1500, tools: 0, reasoning: 0, skipped: 0, candidates: [], cursor: null,
      hits: [{ sessionID: "s", messageID: navigationMessageId(900), role: "user", partIndex: 0, kind: "text", excerpt: "Passage 900" }],
    }) }))
    await f.page.evaluate(() => (window as any).fixture.openSearch())
    await f.page.getByRole("searchbox").fill("Passage")
    await f.page.locator(".history-search-result").first().click()
    await assertPassageAtTop(f.page, 900)
    const occurrence = await activeOccurrence(f.page)
    assert.ok(occurrence && occurrence.top >= 0 && occurrence.bottom <= occurrence.viewport, `the occurrence must be visible: ${JSON.stringify(occurrence)}`)
    assert.deepEqual(f.errors, [])
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
    await f.page.locator(".message-timeline").hover()
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

test("a resized timeline keeps its bottom edge anchored", async () => {
  const f = await fixture()
  try {
    const rail = f.page.locator(".message-timeline")
    await rail.hover()
    await rail.evaluate(element => { element.scrollTop = element.scrollHeight / 2 })
    const before = await rail.evaluate(element => ({ height: element.clientHeight, bottom: element.scrollTop + element.clientHeight }))
    // Markers resize in the same step (zoom-like): the anchor must survive the geometry update.
    await rail.evaluate(element => {
      document.head.appendChild(document.createElement("style")).textContent = ".message-timeline-segment { height: 26px !important }"
      element.style.maxHeight = `${element.clientHeight - 120}px`
    })
    await f.page.waitForTimeout(300)
    const after = await rail.evaluate(element => ({ height: element.clientHeight, bottom: element.scrollTop + element.clientHeight }))
    assert(after.height < before.height && Math.abs(after.bottom - before.bottom) < 2, JSON.stringify({ before, after }))
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("timeline previews render bounded Markdown for historical and resident messages", async () => {
  const f = await fixture(true)
  try {
    const before = await snapshot(f.page)
    const rail = f.page.locator('.message-timeline')
    for (const index of [252, 1452]) {
      await rail.hover()
      await rail.evaluate((element, index) => { element.scrollTop = element.scrollHeight * index / 1500 }, index)
      const marker = rail.locator(`[data-message-id="${navigationMessageId(index)}"]`).first()
      await marker.hover()
      const preview = f.page.getByRole('tooltip')
      await preview.waitFor()
      const geometry = await preview.evaluate(element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
        return { width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          background: style.backgroundColor, border: style.borderTopWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
          text: element.textContent, richCards: element.querySelectorAll('.message-preview,.message-item-base').length,
          bold: element.querySelector('strong')?.textContent }
      })
      assert(geometry.width <= 361 && geometry.width >= 300, JSON.stringify(geometry))
      assert(geometry.left >= 15 && geometry.top >= 15 && geometry.right <= 1185 && geometry.bottom <= 785, JSON.stringify(geometry))
      assert(geometry.height <= 420, 'rich excerpts remain viewport bounded')
      assert.notEqual(geometry.background, 'rgba(0, 0, 0, 0)')
      assert.equal(geometry.border, '1px')
      assert.equal(geometry.scrollWidth, geometry.clientWidth)
      assert.equal(geometry.richCards, 0)
      assert.equal(geometry.bold, 'formatting')
      assert(geometry.text?.includes(`Passage ${index}`))
      await marker.focus()
      await marker.press('Escape')
      await preview.waitFor({ state: 'detached' })
    }
    assert.equal(f.windows.length, 0, 'hover never requests a transcript window')
    assert.equal((await snapshot(f.page)).nativeLists, before.nativeLists, 'hover never fetches a native message')
    assert(f.previewRequests.every(ids => ids.length <= 12), 'excerpt fetches are bounded batches')
    assert(new Set(f.previewRequests.flat()).size < 400, 'preview requests follow the viewed area, not the full history')
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("mixed timeline keeps an exact scrollbar extent throughout manual browsing and hidden tools", async () => {
  const f = await fixture(true)
  try {
    const rail = f.page.locator('.message-timeline')
    await f.page.evaluate(() => (window as any).fixture.tools(true))
    await rail.evaluate(element => { element.scrollTop = 0 })
    for (const [index, icon] of [[1, "terminal"], [6, "book-open"], [11, "search"]] as const) {
      const historicalTool = rail.locator(`.message-timeline-tool[data-message-id="${navigationMessageId(index)}"]`)
      await historicalTool.waitFor()
      assert.equal(await historicalTool.locator(`svg.lucide-${icon}`).count(), 1,
        `indexed tool ${index} keeps its ${icon} icon without loading the historical message`)
      assert.equal(await historicalTool.locator("svg.lucide-layout-grid").count(), 0)
    }
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
    return { x: rect.right - inset / 2, ratio, travel, inset, track, height,
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height },
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
      y: ratio > 0.99 ? rect.bottom - 16 : ratio < 0.01 ? rect.top + 16 : rect.top + inset + height / 2 + travel * ratio }
  })
  if (process.env.CODENOMAD_THUMB_EVIDENCE && selector === '.message-timeline') {
    await page.screenshot({ path: path.join(process.env.CODENOMAD_THUMB_EVIDENCE, 'thumb-start.png') })
  }
  await page.mouse.move(geometry.x, geometry.y)
  await page.mouse.down()
  try {
    await page.waitForTimeout(750)
    // Preserve the native thumb's grab offset by moving the ratio delta from
    // the press. Dispatch the endpoint once: Chromium can leave rapid synthetic
    // interpolation one event short even while pressed through two DOM frames.
    // This remains a real held native-thumb drag, without setting scrollTop,
    // retrying input, changing the target, or relaxing the ratio assertion.
    const targetY = geometry.y + geometry.travel * (fraction - geometry.ratio)
    await page.mouse.move(geometry.x, targetY)
    const frame = await page.waitForFunction(selector => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const element = document.querySelector(selector)!
        resolve({ top: element.scrollTop, clientHeight: element.clientHeight, extent: element.scrollHeight,
          ratio: element.scrollTop / (element.scrollHeight - element.clientHeight) })
      }))
    }), selector, { timeout: 1000 })
    return { geometry, fraction, targetY, pressed: await frame.jsonValue() }
  } finally { await page.mouse.up() }
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
    const gesture = await dragNativeThumb(f.page, '.message-timeline', 0.5)
    await f.page.waitForTimeout(400)
    const read = () => f.page.locator('.message-timeline').evaluate(element => ({
      top: element.scrollTop, extent: element.scrollHeight,
      ratio: element.scrollTop / (element.scrollHeight - element.clientHeight),
    }))
    const middle = await read()
    if (process.env.CODENOMAD_THUMB_EVIDENCE) {
      const evidence = process.env.CODENOMAD_THUMB_EVIDENCE
      await mkdir(evidence, { recursive: true })
      await writeFile(path.join(evidence, 'thumb-middle.json'), JSON.stringify({ gesture, middle, before }, null, 2))
      await f.page.screenshot({ path: path.join(evidence, 'thumb-middle.png') })
    }
    assert(Math.abs(middle.ratio - 0.5) < 0.02, JSON.stringify(middle))
    await f.page.evaluate(() => (window as any).fixture.stream('Live token while browsing the rail.'))
    await f.page.waitForTimeout(400)
    assert(Math.abs((await read()).top - middle.top) < 2, 'new transcript content must not reclaim the rail')
    assert.equal((await snapshot(f.page)).window.kind, before.window.kind)
    assert.equal(f.windows.length, 0, 'dragging the rail must not page the transcript')
    assert.deepEqual(f.errors, [])
    if (process.env.CODENOMAD_THUMB_EVIDENCE) {
      const evidence = process.env.CODENOMAD_THUMB_EVIDENCE
      await writeFile(path.join(evidence, 'thumb-streamed.json'), JSON.stringify({ gesture, middle, streamed: await read(),
        after: await snapshot(f.page), windows: f.windows, errors: f.errors }, null, 2))
      await f.page.screenshot({ path: path.join(evidence, 'thumb-streamed.png') })
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
