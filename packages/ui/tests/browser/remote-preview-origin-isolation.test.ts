import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import pino from "pino"
import { chromium } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { RemoteServerBrowseManager } from "../../../server/src/codenomad-servers/browse-manager"
import { RemotePreviewCapabilities } from "../../../server/src/codenomad-servers/preview-capabilities"
import { RELAY_AUTHORITY_HEADER, RELAY_BOOTSTRAP } from "../../../server/src/codenomad-servers/relay-authority"

const TOKEN = "33333333-3333-4333-8333-333333333333"
async function backend(t: TestContext, label: string) {
  const sockets = new Set<Socket>()
  const server = http.createServer(async (request, reply) => {
    if (request.url === "/api/meta") return reply.end(JSON.stringify({ serverId: label }))
    if (request.url === "/api/previews") {
      let body = ""
      for await (const chunk of request) body += chunk
      return reply.end(JSON.stringify({ token: TOKEN, sessionId: JSON.parse(body).sessionId, targetUrl: "http://app.invalid/start",
        proxyUrl: `/previews/${TOKEN}/start`, createdAt: new Date().toISOString() }))
    }
    if (request.url === `/api/previews/${TOKEN}`) return reply.writeHead(204).end()
    const pathname = request.url!.slice(`/previews/${TOKEN}`.length)
    if (pathname === "/data") return reply.writeHead(200, { "content-type": "text/plain" }).end(`private-${label}`)
    if (pathname === "/script.js") return reply.writeHead(200, { "content-type": "application/javascript" }).end(`window.foreignScript="${label}"`)
    if (pathname === "/image.png") return reply.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq0kAAAAASUVORK5CYII=", "base64"))
    reply.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body>${label}<script>
      window.ready=true;if(parent!==window)parent.postMessage({previewFrame:"${label}"},"*");
    </script></body></html>`)
  })
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  server.on("upgrade", (request, socket: Socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const payload = Buffer.from(`private-${label}`)
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
    socket.once("end", () => socket.end())
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

async function fixture(t: TestContext) {
  const a = await backend(t, "A"), b = await backend(t, "B")
  const ui = await backend(t, "UI")
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "preview-origin-isolation-"))
  const manager = new RemoteServerBrowseManager({
    getOwner: () => ({ remoteServers: [{ id: "a", baseUrl: a }, { id: "b", baseUrl: b }] }),
    configYamlPathForAuthority: () => path.join(directory, "config.yaml"),
  })
  const previews = new RemotePreviewCapabilities(manager, pino({ level: "silent" }))
  const caps = []
  for (const id of ["a", "b"]) {
    const proof = (await manager.relay(id, "/api/meta", {}, RELAY_BOOTSTRAP)).headers.get(RELAY_AUTHORITY_HEADER)!
    caps.push(await previews.create(id, proof, { sessionId: "same", url: "http://app.invalid/start" }, undefined, ui))
  }
  assert.equal(caps[0]!.token, caps[1]!.token)
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  t.after(async () => { await browser.close(); await previews.close(); manager.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const page = await browser.newPage()
  await page.addInitScript("window.__name = value => value")
  await page.goto(caps[0]!.contentUrl)
  await page.waitForFunction(() => (window as any).ready)
  return { page, a: caps[0]!, b: caps[1]!, ui }
}

test("a real preview cannot read another known capability through CORS, WS, no-CORS resources or an iframe", { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  const result = await f.page.evaluate(async source => {
    const target = new URL(source).origin
    const fetchRead = await fetch(`${target}/data`).then(r => r.text(), () => "blocked")
    const xhrRead = await new Promise<string>(resolve => {
      const xhr = new XMLHttpRequest()
      xhr.open("GET", `${target}/data`)
      xhr.onload = () => resolve(xhr.responseText)
      xhr.onerror = () => resolve("blocked")
      xhr.send()
    })
    const wsRead = await new Promise<string>(resolve => {
      const ws = new WebSocket(target.replace("http:", "ws:") + "/ws")
      ws.onmessage = event => { resolve(event.data); ws.close() }
      ws.onerror = () => resolve("blocked")
    })
    const noCorsFetch = await fetch(`${target}/data`, { mode: "no-cors" }).then(() => "loaded", () => "blocked")
    const script = await new Promise<string>(resolve => {
      const element = document.createElement("script")
      element.src = `${target}/script.js`
      element.onload = () => resolve((window as any).foreignScript ?? "loaded")
      element.onerror = () => resolve("blocked")
      document.body.append(element)
    })
    const image = await new Promise<string>(resolve => {
      const element = document.createElement("img")
      element.src = `${target}/image.png`
      element.onload = () => resolve("loaded")
      element.onerror = () => resolve("blocked")
      document.body.append(element)
    })
    const frame = await new Promise<string>(resolve => {
      let received = false
      const listener = (event: MessageEvent) => { if (event.data?.previewFrame === "B") received = true }
      window.addEventListener("message", listener)
      const element = document.createElement("iframe")
      element.src = `${target}/frame`
      element.onload = () => setTimeout(() => {
        window.removeEventListener("message", listener)
        resolve(received ? "loaded" : "blocked")
      }, 100)
      document.body.append(element)
    })
    return { fetchRead, xhrRead, wsRead, noCorsFetch, script, image, frame }
  }, f.b.contentUrl)
  t.diagnostic(JSON.stringify(result))
  assert.deepEqual(result, { fetchRead: "blocked", xhrRead: "blocked", wsRead: "blocked", noCorsFetch: "blocked",
    script: "blocked", image: "blocked", frame: "blocked" })
})

test("an opaque sandbox cannot borrow either preview's HTTP or WS authority", { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  const result = await f.page.evaluate(async sources => new Promise(resolve => {
    const frame = document.createElement("iframe")
    frame.sandbox.add("allow-scripts")
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !event.data?.opaqueProbe) return
      window.removeEventListener("message", listener)
      resolve(event.data.opaqueProbe)
    }
    window.addEventListener("message", listener)
    frame.srcdoc = `<script>(async()=>{
      const result=[];
      for(const source of ${JSON.stringify(sources)}) {
        const origin=new URL(source).origin;
        result.push(await fetch(origin+"/data").then(r=>r.text(),()=>"blocked"));
        result.push(await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open("GET",origin+"/data");
          xhr.onload=()=>resolve(xhr.responseText);xhr.onerror=()=>resolve("blocked");xhr.send()}));
        result.push(await new Promise(resolve=>{const ws=new WebSocket(origin.replace("http:","ws:")+"/ws");
          ws.onmessage=e=>{resolve(e.data);ws.close()};ws.onerror=()=>resolve("blocked")}));
      }
      parent.postMessage({opaqueProbe:result},"*");
    })()<\/script>`
    document.body.append(frame)
  }), [f.a.contentUrl, f.b.contentUrl])
  t.diagnostic(JSON.stringify(result))
  assert.deepEqual(result, Array(6).fill("blocked"))
})

test("an isolated preview keeps its actual origin and can read its own HTTP, image and WS resources", { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  const origin = new URL(f.a.contentUrl).origin
  assert.equal(await f.page.evaluate(() => window.origin), origin)
  const headers = await f.page.evaluate(async () => Object.fromEntries((await fetch("/data")).headers))
  assert.equal(headers["access-control-allow-origin"], origin)
  assert.equal(headers["cross-origin-resource-policy"], "same-origin")
  const own = await f.page.evaluate(async () => ({
    http: await fetch("/data").then(r => r.text()),
    ws: await new Promise(resolve => {
      const ws = new WebSocket(location.origin.replace("http:", "ws:") + "/ws")
      ws.onmessage = event => { resolve(event.data); ws.close() }
      ws.onerror = () => resolve("blocked")
    }),
    image: await new Promise(resolve => {
      const image = new Image()
      image.onload = () => resolve("loaded")
      image.onerror = () => resolve("blocked")
      image.src = "/image.png"
    }),
  }))
  assert.deepEqual(own, { http: "private-A", ws: "private-A", image: "loaded" })
})

test("the issuing UI can embed both isolated documents without sharing their DOM origin", { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  await f.page.goto(f.ui)
  await f.page.evaluate(sources => {
    for (const source of sources) {
      const frame = document.createElement("iframe")
      frame.sandbox.add("allow-scripts", "allow-same-origin")
      frame.src = source
      document.body.append(frame)
    }
  }, [f.a.contentUrl, f.b.contentUrl])
  for (const [index, cap] of [f.a, f.b].entries()) {
    await f.page.frameLocator("iframe").nth(index).locator("body").filter({ hasText: index ? "B" : "A" }).waitFor()
    const frame = f.page.frames().find(frame => frame.url() === cap.contentUrl)!
    await frame.waitForFunction(() => (window as any).ready)
    assert.equal(await frame.evaluate(() => window.origin), new URL(cap.contentUrl).origin)
    assert.equal(await frame.evaluate(() => { try { return parent.document.body.innerText } catch { return "blocked" } }), "blocked")
  }
})
