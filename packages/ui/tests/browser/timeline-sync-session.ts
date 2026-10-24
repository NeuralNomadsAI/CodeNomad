import { readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "playwright"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { readNavigationWindow, readSessionOutline } from "../../../server/src/opencode/session-pruning/navigation-store"
import { readOutlinePreviews } from "../../../server/src/opencode/session-pruning/outline-preview"
import { createFixtureCache } from "./fixture-cache"

/** A native-shaped session store, read by the real outline, window and preview readers. */
export function createSessionStore(path: string, messages: Array<{ id: string; type: string } & Record<string, unknown>>) {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_updated INTEGER DEFAULT 0);
    CREATE UNIQUE INDEX seq_idx ON session_message(session_id,seq);
    INSERT INTO session_v2 VALUES ('s','/fixture','p',NULL,NULL);`)
  const insert = db.prepare("INSERT INTO session_message(id,session_id,type,seq,data) VALUES (?,'s',?,?,?)")
  messages.forEach(({ id, type, ...data }, seq) => insert.run(id, type, seq, JSON.stringify(data)))
  db.close()
}

/**
 * Serves `fixtures/timeline-sync.tsx` (the real SessionView). `instrument`
 * publishes the rail's markers as `globalThis.__timeline` and stamps their ids,
 * for measurements that need marker identities beyond the rendered range.
 */
export async function startTimelineSyncServer(options: { instrument?: boolean } = {}) {
  const cache = await createFixtureCache()
  const shutdown = createFixtureShutdown(cache)
  const server = await createServer({ configFile: false, cacheDir: cache.cacheDir, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [shutdown.plugin, solid(), { name: "timeline-sync", enforce: "pre", async load(id) {
      const file = id.split("?")[0]
      if (!options.instrument || !file.replaceAll("\\", "/").endsWith("/src/components/message-timeline.tsx")) return
      const source = await readFile(file, "utf8")
      const stamped = source.replace("data-message-id={segment.messageId}", "data-message-id={segment.messageId} data-segment-id={segment.id}")
      const marker = /\n  return \(\r?\n    <div class="message-timeline-container">/
      if (stamped === source || !marker.test(stamped)) throw new Error("timeline instrumentation anchor missing")
      return stamped.replace(marker, match => `\n  ;(globalThis as any).__timeline = { visible: () => visibleSegments(), active: () => activeVisibleId() }${match}`)
    }, configureServer(s) { s.middlewares.use("/fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="/tests/browser/fixtures/timeline-sync.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined,
    ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] })
  armFixtureNavigationBudget(browser)
  return { browser, url: `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`,
    close: async () => { await browser.close(); await server.close(); await cache.dispose() } }
}

/** Answers native `message.list` and the session-history routes from `path`, then loads the fixture. */
export async function openTimelineSession(page: Page, url: string, path: string, preset: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  const count = Number(db.prepare("SELECT count(*) AS n FROM session_message").get()!.n)
  const row = (r: any) => ({ ...JSON.parse(r.data), id: r.id, type: r.type })
  const state = { outlineDone: false, windows: 0, errors: [] as string[] }
  page.on("pageerror", error => state.errors.push(error.message))
  // tsx keeps function names with a helper that evaluated callbacks need too.
  await page.addInitScript({ content: "globalThis.__name = (target) => target" })
  await page.route("**/fixture-native/list", async route => {
    const { cursor, limit = 200, order } = JSON.parse(route.request().postData() ?? "{}")
    const page = (start: number, end: number, descending: boolean) => db.prepare(`SELECT id,type,data FROM session_message WHERE seq>=? AND seq<? ORDER BY seq ${descending ? "DESC" : ""}`).all(start, end).map(row)
    let body
    if (order === "asc" || cursor?.startsWith("asc:")) {
      const start = cursor ? Number(cursor.slice(4)) : 0, end = Math.min(count, start + limit)
      body = { data: page(start, end, false), cursor: end < count ? { next: `asc:${end}` } : {} }
    } else {
      const end = cursor ? Number(cursor) : count, start = Math.max(0, end - limit)
      body = { data: page(start, end, true), cursor: start ? { next: String(start) } : {} }
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) }).catch(() => {})
  })
  await page.route("**/api/**", async route => {
    const request = route.request(), method = request.url().split("/").at(-1)
    if (new URL(request.url()).pathname.endsWith("/permission-receipts")) return route.fulfill({ contentType: "application/json", body: '{"receipts":[]}' })
    if (!request.url().includes("/session-history/") || !["outline", "outlinePreview", "window"].includes(method!)) {
      return route.fulfill({ contentType: "application/json", body: "{}" })
    }
    const input = request.postDataJSON()
    const scope = { directory: "/fixture", projectID: "p", sessionID: input.sessionID }
    // Production opens an independent read-only connection for every RPC.
    const reader = new DatabaseSync(path, { readOnly: true })
    try {
      const response = method === "window" ? await readNavigationWindow(reader, scope, input.target, new AbortController().signal)
        : method === "outlinePreview" ? await readOutlinePreviews(reader, scope, input.messageIDs, new AbortController().signal)
          // As the backend's versioned outline call, with layouts.
          : await readSessionOutline(reader, scope, input.cursor, new AbortController().signal, input.after, input.known, true)
      if (method === "outline" && (response as any).cursor === null) state.outlineDone = true
      if (method === "window") state.windows++
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) }).catch(() => {})
    } finally { reader.close() }
  })
  await page.goto(`${url}?preset=${preset}`)
  await page.waitForFunction(() => Boolean((window as any).fixture), {}, { timeout: 60000 })
  const deadline = Date.now() + 60000
  while (!state.outlineDone && Date.now() < deadline) await page.waitForTimeout(50)
  if (!state.outlineDone) throw new Error("the outline scan did not complete")
  await page.waitForFunction(() => (window as any).fixture.ids().length > 0, {}, { timeout: 60000 })
  await settleTranscript(page)
  return { db, state, close: () => db.close() }
}

/** Waits until navigation and both scrollers have been still for 12 frames. */
export async function settleTranscript(page: Page, minMs = 300) {
  await page.waitForTimeout(minMs)
  await page.evaluate(() => new Promise<void>(resolve => {
    let still = 0, last = "", frames = 0
    const tick = () => {
      const stream = document.querySelector<HTMLElement>(".message-stream"), rail = document.querySelector<HTMLElement>(".message-timeline")
      const key = `${stream?.scrollTop}|${stream?.scrollHeight}|${rail?.scrollTop}|${document.querySelector(".history-navigation-status") ? 1 : 0}|${document.querySelector('.message-timeline-segment[aria-current="true"]')?.outerHTML.length}`
      still = key === last ? still + 1 : 0
      last = key
      if (still >= 12 || ++frames > 600) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }))
}

// Transcript items in DOM order, collected across the virtualized resident window.
async function collectTranscript(page: Page) {
  const items = new Map<string, any>()
  const pass = () => page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".message-stream")!
    const view = stream.getBoundingClientRect()
    const out: any[] = []
    for (const row of stream.querySelectorAll<HTMLElement>("[data-virtual-follow-key]")) {
      const messageId = row.dataset.virtualFollowKey!
      let order = 0
      for (const el of row.querySelectorAll<HTMLElement>('.message-item-base, .tool-call-message[data-part-id], .message-exploration-group[data-group-part-ids], .message-reasoning-card[data-part-id], .message-reasoning-group[data-group-part-ids], [data-message-kind="system"], .message-compaction-card, .message-hidden-parts')) {
        const rect = el.getBoundingClientRect()
        const kind = el.classList.contains("message-item-base") ? (el.dataset.messageRole === "user" ? "user" : "content")
          : el.classList.contains("tool-call-message") ? "tool" : el.classList.contains("message-exploration-group") ? "group"
            : el.classList.contains("message-reasoning-card") ? "reasoning" : el.classList.contains("message-reasoning-group") ? "reasoning-group"
              : el.dataset.messageKind === "system" ? "system" : el.classList.contains("message-compaction-card") ? "compaction" : "hidden-parts"
        const key = kind === "content" || kind === "user" ? `${messageId}|${kind}|${el.dataset.messageContentStartPartId}`
          : kind === "tool" || kind === "reasoning" ? `${messageId}|${kind}|${el.dataset.partId}`
            : kind === "group" || kind === "reasoning-group" ? `${messageId}|${kind}|${el.dataset.groupPartIds}` : `${messageId}|${kind}|${order}`
        out.push({ key, messageId, kind, order: order++, start: el.dataset.messageContentStartPartId, partId: el.dataset.partId,
          groupPartIds: el.dataset.groupPartIds?.split(" "), height: rect.height, grouped: kind === "reasoning" && Boolean(el.closest(".message-reasoning-group")), renderedTools: kind === "group" ? [...el.querySelectorAll<HTMLElement>(".tool-call-message[data-part-id]")].map(t => t.dataset.partId) : undefined,
          hasError: kind === "content" ? Boolean(el.querySelector(".message-error, [data-message-error], .message-item-error")) : undefined,
          textLength: kind === "content" ? (el.querySelector(".message-item-content, .message-text, .markdown-body")?.textContent ?? "").trim().length : undefined })
      }
    }
    return { out, top: stream.scrollTop, height: stream.clientHeight, scrollHeight: stream.scrollHeight }
  })
  // A wheel gesture leaves bottom-following; programmatic offsets then read the
  // window without paging once its intent has expired.
  const box = (await page.locator(".message-stream").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(800)
  await page.evaluate(() => { document.querySelector<HTMLElement>(".message-stream")!.scrollTop = 0 })
  await settleTranscript(page, 50)
  for (let guard = 0; guard < 4000; guard++) {
    const result = await pass()
    for (const item of result.out) items.set(item.key, item)
    if (result.top + result.height >= result.scrollHeight - 1) break
    await page.evaluate(step => { const s = document.querySelector<HTMLElement>(".message-stream")!; s.scrollTop += step }, Math.max(200, result.height * 0.85))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  return [...items.values()]
}

export type TranscriptMarker = { kind: string; partId?: string }

/**
 * The rendered transcript's marked blocks per message, in part order: each
 * content row, tool (a collapsed group's tools included), thinking card or
 * group, system and compaction block. `messageOf` maps ids to native records.
 */
export async function collectTranscriptMarkers(page: Page, messageOf: Map<string, any>) {
  const dom = await collectTranscript(page)
  const byMessage = new Map<string, TranscriptMarker[]>()
  let errorRows = 0
  for (const item of dom) {
    const list = byMessage.get(item.messageId) ?? []
    const message = messageOf.get(item.messageId)
    if (item.kind === "user") list.push({ kind: "user" })
    else if (item.kind === "content") {
      const index = Number(item.start?.split("-").at(-1))
      const part = message?.content?.[index]
      if (item.start?.endsWith("-error") || !part || part.type !== "text" || !String(part.text ?? "").trim()) { errorRows++; continue }
      list.push({ kind: "assistant", partId: item.start })
    } else if (item.kind === "tool") list.push({ kind: "tool", partId: item.partId })
    else if (item.kind === "group") { for (const id of item.groupPartIds ?? []) if (!item.renderedTools?.includes(id)) list.push({ kind: "tool", partId: id }) }
    // A thinking run is one card, or one group whatever it shows.
    else if (item.kind === "reasoning") { if (!item.grouped) list.push({ kind: "reasoning", partId: item.partId }) }
    else if (item.kind === "reasoning-group") list.push({ kind: "reasoning", partId: item.groupPartIds?.[0] })
    else if (item.kind === "system" || item.kind === "compaction") list.push({ kind: item.kind })
    byMessage.set(item.messageId, list)
  }
  // DOM collection orders a group's collapsed tools at the group; restore part order.
  for (const [messageId, list] of byMessage) {
    const message = messageOf.get(messageId)
    const order = new Map<string, number>((message?.content ?? []).map((p: any, i: number) => [p.type === "tool" ? p.id : `${messageId}-${p.type}-${i}`, i]))
    list.sort((a, b) => (a.partId && b.partId && order.has(a.partId) && order.has(b.partId)) ? order.get(a.partId)! - order.get(b.partId)! : 0)
  }
  return { dom, byMessage, errorRows }
}
