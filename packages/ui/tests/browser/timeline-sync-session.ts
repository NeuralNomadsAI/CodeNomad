import { readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "playwright"
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
  const server = await createServer({ configFile: false, cacheDir: cache.cacheDir, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "timeline-sync", enforce: "pre", async load(id) {
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
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined,
    ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] })
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
          : await readSessionOutline(reader, scope, input.cursor, new AbortController().signal, input.after, input.known)
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
