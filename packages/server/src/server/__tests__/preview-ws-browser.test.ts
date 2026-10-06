import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { createServer as createUpstreamServer, type IncomingHttpHeaders } from "node:http"
import type { Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import { after, before, it } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { AuthManager } from "../../auth/manager"
import type { Logger } from "../../logger"
import { PreviewManager } from "../../previews/manager"
import { createHttpServer } from "../http-server"

const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {}, trace() {}, isLevelEnabled: () => false } as unknown as Logger
const previews = new PreviewManager()
const sockets = new Set<Socket>()
const requests: { mode: string; headers: IncomingHttpHeaders }[] = []
let browser: Browser | undefined
let app: ReturnType<typeof createHttpServer> | undefined
let upstream: ReturnType<typeof createUpstreamServer> | undefined
let directory: string | undefined
let auth: AuthManager
let origin: string
let base: string

function track(socket: Socket) {
  sockets.add(socket)
  socket.once("close", () => sockets.delete(socket))
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  assert.ok(payload.length < 126)
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
}

// Deliberately small, real RFC 6455 echo peer. Browser client frames are masked;
// all fixture messages fit the short-length form. No WebSocket client emulation.
function echoFrames(socket: Socket, head: Buffer) {
  let pending = Buffer.alloc(0)
  const consume = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f
      const length = pending[1] & 0x7f
      if (!(pending[1] & 0x80) || length >= 126) return socket.destroy()
      if (pending.length < 6 + length) return
      const mask = pending.subarray(2, 6)
      const payload = Buffer.from(pending.subarray(6, 6 + length))
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
      pending = pending.subarray(6 + length)
      if (opcode === 0x8) { socket.end(Buffer.from([0x88, 0])); return }
      if (opcode === 0x1) socket.write(textFrame(payload.toString()))
    }
  }
  socket.on("data", consume)
  socket.on("error", () => {})
  if (head.length) consume(head)
}

function installedChromium(): string {
  if (process.env.CODENOMAD_BROWSER_PATH) {
    assert.ok(fs.existsSync(process.env.CODENOMAD_BROWSER_PATH), "CODENOMAD_BROWSER_PATH must exist; this test never installs a browser")
    return process.env.CODENOMAD_BROWSER_PATH
  }
  if (fs.existsSync(chromium.executablePath())) return chromium.executablePath()
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA!, "ms-playwright")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "ms-playwright") : path.join(os.homedir(), ".cache", "ms-playwright"))
  for (const entry of fs.existsSync(cache) ? fs.readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse() : []) {
    for (const relative of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const candidate = path.join(cache, entry, relative)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error("No installed Chromium found. Set CODENOMAD_BROWSER_PATH; this regression never downloads browsers.")
}

before(async () => {
  const executablePath = installedChromium()
  const tempRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir()
  fs.mkdirSync(tempRoot, { recursive: true })
  directory = fs.mkdtempSync(path.join(tempRoot, "preview-ws-browser-"))
  const staticDir = path.join(directory, "ui")
  const fixture = fileURLToPath(new URL("./fixtures/preview-ws-browser.tsx", import.meta.url))
  // Compile the actual Solid BrowserFrame once, then serve it from the actual
  // production backend origin. No development proxy or mock response sanitizer.
  await build({ configFile: false, root: fileURLToPath(new URL("../../../../ui", import.meta.url)), logLevel: "error",
    plugins: [solid()], resolve: { dedupe: ["solid-js"] }, css: { postcss: {} },
    build: { outDir: staticDir, emptyOutDir: false, minify: false,
      rollupOptions: { input: fixture, output: { entryFileNames: "fixture.js" } } },
  })
  fs.writeFileSync(path.join(staticDir, "index.html"), '<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>')
  auth = new AuthManager({ configPath: path.join(directory, "config.yaml"), username: "fixture", password: "disposable-browser-password", generateToken: false }, logger)
  upstream = createUpstreamServer((request, response) => {
    const mode = new URL(request.url!, "http://fixture").searchParams.get("mode")!
    response.setHeader("content-type", "text/html")
    response.end(`<!doctype html><html><head></head><body><button id="open">Open socket</button><pre id="result"></pre><script>
      document.getElementById('open').addEventListener('click', () => {
      const result = { opened: false, messages: [], failed: false, opaque: false };
      try { void parent.document; } catch { result.opaque = true; }
      const ws = new WebSocket('/socket?mode=' + ${JSON.stringify(mode)});
      const output = document.getElementById('result');
      const timer = setTimeout(() => { result.timeout = true; finish(); ws.close(); }, 10000);
      function finish() { clearTimeout(timer); output.textContent = JSON.stringify(result); output.dataset.done = 'true'; }
      ws.onopen = () => { result.opened = true; ws.send('browser-echo'); };
      ws.onmessage = event => { result.messages.push(event.data); if (result.messages.length === 2) ws.close(1000); };
      ws.onerror = () => { result.failed = true; };
      ws.onclose = () => finish();
      }, { once: true });
    </script></body></html>`)
  })
  upstream.on("connection", track)
  upstream.on("upgrade", (request, socket, head) => {
    const peer = socket as Socket
    const mode = new URL(request.url!, "http://fixture").searchParams.get("mode")!
    requests.push({ mode, headers: request.headers })
    const maliciousCookies = [
      `sEt-CoOkIe: ${auth.getCookieName()}=attacker-overwrite; Path=/; HttpOnly; SameSite=None; Secure`,
      "Set-Cookie: preview_extra=attacker; Path=/; SameSite=None; Secure",
      "SET-COOKIE: preview_copy=attacker; Path=/; SameSite=None; Secure",
      "sEt-CoOkIe2: preview_legacy=attacker; Path=/",
    ]
    if (mode === "redirect") {
      peer.end(["HTTP/1.1 302 Found", "Location: /api/auth/status", ...maliciousCookies, "Content-Length: 0", "Connection: close", "", ""].join("\r\n"))
      return
    }
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    const headers = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`,
      ...(mode === "malicious" ? maliciousCookies : []), "", ""].join("\r\n")
    // Headers and the first complete frame share a single upstream write.
    peer.write(Buffer.concat([Buffer.from(headers), textFrame("early-coalesced")]))
    echoFrames(peer, head)
  })
  await new Promise<void>(resolve => upstream!.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  assert.ok(address && typeof address === "object")
  const preview = previews.create("disposable-browser-session", `http://127.0.0.1:${address.port}`)
  base = previews.buildProxyBasePath(preview.token)
  // Unrelated integrations are inert, exactly as in the preview-security fixture.
  app = createHttpServer({ bindHost: "127.0.0.1", bindPort: 0, defaultPort: 0, protocol: "http", logger,
    authManager: auth, previewManager: previews, uiStaticDir: staticDir,
    workspaceManager: {}, settings: {}, fileSystemBrowser: {}, eventBus: {}, serverMeta: {}, instanceStore: {},
    speechService: {}, sidecarManager: {}, clientConnectionManager: {}, remoteProxySessionManager: {},
    yoloManager: {}, nativeParent: {}, automationBridgeToken: "disposable-browser-fixture",
  } as unknown as Parameters<typeof createHttpServer>[0])
  app.instance.server.on("connection", track)
  origin = `http://127.0.0.1:${(await app.start()).port}`
  browser = await chromium.launch({ executablePath, timeout: 20_000 })
  console.log(`Disposable preview browser: ${executablePath}`)
}, { timeout: 60_000 })

after(async () => {
  // Close the isolated context/browser before stopping the production backend;
  // destroy only owned listener connections, including upgraded sockets.
  try {
    await browser?.close()
  } finally {
    for (const socket of sockets) socket.destroy()
    try {
      await app?.stop()
    } finally {
      try {
        if (upstream) await new Promise<void>(resolve => upstream!.close(() => resolve()))
      } finally {
        if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  }
}, { timeout: 30_000 })

for (const mode of ["malicious", "redirect", "normal"]) {
  it(`${mode} preview WebSocket preserves the actual browser login cookie and auth status`, { timeout: 30_000 }, async () => {
    const context = await browser!.newContext()
    try {
      // Only provider reads are fixtures. Login, auth status, preview HTTP and
      // WebSocket traffic still use the real isolated production backend.
      for (const [endpoint, json] of Object.entries({
        "/api/storage/config/ui": { settings: { locale: "en" } },
        "/api/storage/config/server": {},
        "/api/storage/state/ui": {},
        "/api/speech/capabilities": { configured: false },
      })) await context.route(`${origin}${endpoint}`, route => {
        assert.equal(route.request().method(), "GET")
        return route.fulfill({ json })
      })
      await context.route(`${origin}/api/events?*`, route => route.fulfill({ contentType: "text/event-stream", body: ": disposable fixture\n\n" }))
      const page = await context.newPage()
      const pageErrors: string[] = []
      page.on("pageerror", error => { pageErrors.push(error.message); console.error(`Preview fixture page error: ${error.message}`) })
      page.setDefaultTimeout(15_000)
      const login = await context.request.post(`${origin}/api/auth/login`, { data: { username: "fixture", password: "disposable-browser-password" }, timeout: 10_000 })
      assert.equal(login.status(), 200)
      const original = await context.cookies(origin)
      assert.equal(original.length, 1)
      assert.equal(original[0].name, auth.getCookieName())
      assert.equal(original[0].httpOnly, true)
      assert.notEqual(original[0].value, "attacker-overwrite")
      await page.goto(`${origin}/?preview=${encodeURIComponent(base)}&mode=${mode}`)
      assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts allow-forms allow-modals allow-popups allow-downloads")
      await page.frameLocator("iframe").locator("#open").waitFor()
      const frame = page.frames().find(frame => frame.url().startsWith(`${origin}${base}/page`))
      assert.ok(frame, "production proxy loads the preview document in its sandbox iframe")
      // Chromium isolates the opaque-origin iframe into its own target. Listen
      // there before opening the socket, not on the unrelated parent target.
      const cdp = await context.newCDPSession(frame)
      await cdp.send("Network.enable")
      const handshakes: { status: number; headers: Record<string, string> }[] = []
      const handshakeErrors: string[] = []
      cdp.on("Network.webSocketHandshakeResponseReceived", event => handshakes.push(event.response))
      cdp.on("Network.webSocketFrameError", event => handshakeErrors.push(event.errorMessage))
      await page.frameLocator("iframe").locator("#open").click()
      const result = JSON.parse(await page.frameLocator("iframe").locator("#result[data-done=true]").textContent() ?? "null") as {
        opened: boolean; messages: string[]; failed: boolean; opaque: boolean; timeout?: boolean
      }
      assert.equal(result.timeout, undefined, JSON.stringify(result))
      assert.equal(result.opaque, true, "actual BrowserFrame must deny preview access to parent DOM")
      assert.equal(result.opened, mode !== "redirect", JSON.stringify(result))
      assert.equal(result.failed, mode === "redirect", JSON.stringify(result))
      assert.deepEqual(result.messages, mode === "redirect" ? [] : ["early-coalesced", "browser-echo"])
      assert.deepEqual(await context.cookies(origin), original, "real HttpOnly login cookie must not change or gain any untrusted cookies")
      if (mode === "redirect") {
        // Chromium reports rejected HTTP handshakes through FrameError, not the
        // successful HandshakeResponse event. Assert its observed status code.
        assert.equal(handshakes.length, 0, JSON.stringify(handshakes))
        assert.equal(handshakeErrors.length, 1, JSON.stringify(handshakeErrors))
        assert.match(handshakeErrors[0], /Unexpected response code: 502/)
      } else {
        assert.equal(handshakes.length, 1, JSON.stringify(handshakes))
        assert.equal(handshakes[0].status, 101)
        assert.ok(Object.keys(handshakes[0].headers).every(name => !/^set-cookie2?$/i.test(name)), "untrusted cookie response fields must not reach Chromium")
        assert.equal(Object.keys(handshakes[0].headers).some(name => name.toLowerCase() === "location"), false)
        assert.deepEqual(handshakeErrors, [])
      }
      const status = await page.evaluate(async () => {
        const response = await fetch("/api/auth/status")
        return { status: response.status, body: await response.json() as { authenticated: boolean } }
      })
      assert.equal(status.status, 200)
      assert.equal(status.body.authenticated, true)
      const seen = requests.filter(request => request.mode === mode)
      assert.equal(seen.length, 1)
      assert.equal(seen[0].headers.cookie, undefined, "preview upstream never receives backend cookies")
      assert.deepEqual(pageErrors, [], "production BrowserFrame and its providers must mount without browser errors")
      console.log(`${mode}: Chromium response ${mode === "redirect" ? 502 : handshakes[0].status}; cookie unchanged; authenticated=true; frames=${result.messages.join(",")}`)
    } finally {
      await context.close()
    }
  })
}
