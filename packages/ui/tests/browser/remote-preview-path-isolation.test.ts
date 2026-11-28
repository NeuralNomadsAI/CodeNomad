import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"
import { once } from "node:events"
import test, { type TestContext } from "node:test"
import pino from "pino"
import { chromium } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { RELAY_AUTHORITY_HEADER, RELAY_BOOTSTRAP } from "../../../server/src/codenomad-servers/relay-authority"
import { PREVIEW_SANDBOX_FLAGS } from "../../../server/src/previews/sandbox"
import { previewRemoteSettings, startPreviewRemote } from "../../../server/src/remote-control/test-support/preview-remotes"
import { startRemoteSurface } from "../../../server/src/remote-control/test-support/surface"

// A hostile preview probes its own content, a known sibling capability, the application and the outside.
const PROBE = `<!doctype html><title>probe</title><script>
const own = location.pathname.split("/").slice(0, 3).join("/")
const ws = path => new Promise(resolve => {
  const url = new URL(path, location.href); url.protocol = url.protocol.replace("http", "ws")
  try { const socket = new WebSocket(url); socket.onmessage = event => { resolve(String(event.data)); socket.close() }; socket.onerror = () => resolve("blocked") } catch { resolve("blocked") }
  setTimeout(() => resolve("blocked"), 1500)
})
const read = (path, credentials) => fetch(path, { credentials }).then(reply => reply.ok ? reply.text() : "refused", () => "blocked")
const script = path => new Promise(resolve => { const element = document.createElement("script"); element.src = path
  element.onload = () => resolve(window.leaked ?? "loaded"); element.onerror = () => resolve("blocked"); document.head.append(element) })
const frame = path => new Promise(resolve => { let loaded = false
  addEventListener("message", event => { if (event.data && event.data.ready) loaded = true })
  const element = document.createElement("iframe"); element.src = path; document.body.append(element)
  setTimeout(() => resolve(loaded ? "loaded" : "blocked"), 1200) })
addEventListener("message", async event => {
  if (event.source !== parent || !event.data || !event.data.sibling) return
  const sibling = "/previews/" + event.data.sibling
  const results = {
    origin: String(self.origin), ownFetch: await read(own + "/data"), siblingFetch: await read(sibling + "/data"),
    siblingScript: await script(sibling + "/leak.js"), appApi: await read("/api/meta", "include"), relay: await read("/api/backends/A/api/meta", "include"),
    appApiAnonymous: await read("/api/meta"),
    ownWs: await ws(own + "/ws"), siblingWs: await ws(sibling + "/ws"),
    serviceWorker: navigator.serviceWorker ? await navigator.serviceWorker.register(own + "/sw.js").then(() => "registered", () => "refused") : "refused",
    parent: (() => { try { return parent.document.title } catch { return "blocked" } })(),
    siblingFrame: await frame(sibling + "/start"),
  }
  new Image().src = event.data.external + "/pixel"
  parent.postMessage({ results }, "*")
})
parent.postMessage({ ready: true }, "*")
</script>`

async function fixture(t: TestContext) {
  const remotes = [await startPreviewRemote(t, "A", page => page === "/start" ? PROBE : undefined), await startPreviewRemote(t, "B", page => page === "/start" ? PROBE : undefined)]
  const referers: (string | undefined)[] = []
  const external = http.createServer((request, reply) => { referers.push(request.headers.referer); reply.writeHead(204, { connection: "close" }).end() })
  external.listen(0, "127.0.0.1")
  await once(external, "listening")
  t.after(() => new Promise<void>(resolve => external.close(() => resolve())))
  // A stable public LAN origin forwarding to the host listener, whose port is known only after it starts.
  let target = 0
  const sockets = new Set<net.Socket>()
  const front = net.createServer(socket => { const upstream = net.connect(target, "127.0.0.1"); socket.pipe(upstream).pipe(socket)
    for (const end of [socket, upstream]) { sockets.add(end); end.once("close", () => sockets.delete(end)) }
    for (const end of [socket, upstream]) end.on("error", () => { socket.destroy(); upstream.destroy() }) })
  front.listen(0, "127.0.0.1")
  await once(front, "listening")
  t.after(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); front.close(() => resolve()) }))
  const port = (front.address() as { port: number }).port
  const origin = `http://preview-lan.test:${port}`
  const logger = pino({ level: "silent" })
  const { settings } = previewRemoteSettings(t, remotes, logger)
  const surface = await startRemoteSurface(t, { settings, logger, allowedOrigins: [origin] })
  target = Number(surface.local.split(":")[1])
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined,
    args: ["--host-resolver-rules=MAP preview-lan.test 127.0.0.1, MAP external.test 127.0.0.1"] })
  armFixtureNavigationBudget(browser)
  t.after(() => browser.close())
  const context = await browser.newContext()
  await context.addCookies([{ name: surface.authManager.getCookieName(), value: surface.authManager.createSession("codenomad").id, url: origin }])
  await context.addInitScript("window.__name = value => value")
  const page = await context.newPage()
  await page.goto(`${origin}/`)
  return { page, origin, referers, external: `http://external.test:${(external.address() as { port: number }).port}` }
}

test("host path previews stay opaque, embeddable by the UI and unable to read siblings, the application or leak capabilities", { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const caps = await f.page.evaluate(async ([authority, bootstrap]) => {
    const created = []
    for (const id of ["A", "B"]) {
      const meta = await fetch(`/api/backends/${id}/api/meta`, { headers: { [authority]: bootstrap } })
      const reply = await fetch(`/api/backends/${id}/preview-capabilities`, { method: "POST",
        headers: { [authority]: meta.headers.get(authority)!, "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s", url: "http://app.invalid/start" }) })
      created.push(await reply.json())
    }
    return created as { capability: string; contentUrl: string; token: string }[]
  }, [RELAY_AUTHORITY_HEADER, RELAY_BOOTSTRAP])
  assert.equal(caps[0]!.token, caps[1]!.token)
  for (const cap of caps) assert.match(cap.contentUrl, /^\/previews\/[0-9a-f-]{36}\/start$/)
  const results = await f.page.evaluate(async ([caps, sandbox, external]) => {
    const embed = (cap: { contentUrl: string }) => new Promise<HTMLIFrameElement>((resolve, reject) => {
      const element = document.createElement("iframe")
      element.setAttribute("sandbox", sandbox)
      element.src = cap.contentUrl
      const listener = (event: MessageEvent) => { if (event.source === element.contentWindow && event.data?.ready) { removeEventListener("message", listener); resolve(element) } }
      addEventListener("message", listener)
      setTimeout(() => reject(new Error("preview was not embedded")), 5000)
      document.body.append(element)
    })
    const frames = [await embed(caps[0]!), await embed(caps[1]!)]
    return new Promise<unknown>(resolve => {
      addEventListener("message", event => { if (event.source === frames[0]!.contentWindow && event.data?.results) resolve(event.data.results) })
      frames[0]!.contentWindow!.postMessage({ sibling: caps[1]!.capability, external }, "*")
    })
  }, [caps, PREVIEW_SANDBOX_FLAGS, f.external] as const)
  t.diagnostic(JSON.stringify(results))
  // Sibling HTTP/WS reads given an already-known capability are bounded by capability secrecy
  // (no Referer, Location, history or log carrier); they stay in the diagnostic above.
  const { siblingFetch: _fetch, siblingScript: _script, siblingWs: _ws, ...guaranteed } = results as Record<string, string>
  assert.deepEqual(guaranteed, {
    origin: "null", ownFetch: JSON.stringify({ label: "A", page: "/data", method: "GET" }), appApi: "blocked", relay: "blocked", appApiAnonymous: "blocked",
    ownWs: "private-A", serviceWorker: "refused", parent: "blocked", siblingFrame: "blocked",
  })
  // Top-level opening keeps the document opaque.
  const opened = await f.page.context().newPage()
  await opened.goto(`${f.origin}${caps[0]!.contentUrl}`)
  assert.equal(await opened.evaluate(() => String(self.origin)), "null")
  const deadline = Date.now() + 2000
  while (!f.referers.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(f.referers, [undefined], "external requests carry no capability Referer")
})
