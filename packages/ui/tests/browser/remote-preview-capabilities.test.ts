import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { RemoteServerBrowseManager } from "../../../server/src/codenomad-servers/browse-manager"
import { registerBackendRelayRoutes } from "../../../server/src/server/routes/backend-relay"
import { registerRemotePreviewCapabilityRoutes } from "../../../server/src/server/routes/remote-preview-capabilities"
import { guardLocalBackendCaller } from "../../../server/src/codenomad-servers/local-caller"
import { startRemoteSurface } from "../../../server/src/remote-control/test-support/surface"

const TOKEN = "22222222-2222-4222-8222-222222222222"
async function appServer(t: TestContext, label: string) {
  const sockets = new Set<Socket>(), streams = new Set<http.ServerResponse>(), upgrades = new Set<Socket>()
  let document = 0
  const server = http.createServer((request, reply) => {
    if (request.url === "/app.css") return reply.writeHead(200, { "content-type": "text/css" }).end("h1 { color: rgb(10,20,30) }")
    if (request.url === "/data") return reply.writeHead(200, { "content-type": "text/plain" }).end(`fetch-${label}`)
    if (request.url === "/stream") {
      streams.add(reply)
      reply.once("close", () => streams.delete(reply))
      reply.writeHead(200, { "content-type": "text/plain" }).write(label)
      return
    }
    if (request.url === "/app.js") return reply.writeHead(200, { "content-type": "application/javascript" }).end(`
      document.querySelector("#asset").textContent = "asset-${label}";
      fetch("/data").then(r=>r.text()).then(text=>document.querySelector("#fetch").textContent=text);
      fetch("/stream").then(async r=>{const reader=r.body.getReader();while(!(await reader.read()).done){} }).catch(()=>{});
      const ws = new WebSocket("ws://"+location.host+"/ws");
      ws.onopen=()=>ws.send("hmr");
      ws.onmessage=e=>document.querySelector("#ws").textContent="${label}:"+e.data;
      window.attack=async(url)=>{try{return await (await fetch(url)).text()}catch{return "blocked"}};
    `)
    reply.writeHead(200, { "content-type": "text/html", "set-cookie": `app=${label}; HttpOnly` }).end(`
      <!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>
      <h1 data-page="${++document}">App ${label}</h1><output id="asset"></output><output id="fetch"></output><output id="ws"></output>
      <a href="/next?q=1#part">Next</a><script src="/app.js"></script></body></html>`)
  })
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  server.on("upgrade", (request, socket: Socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    upgrades.add(socket)
    socket.once("close", () => upgrades.delete(socket))
    socket.once("end", () => socket.end())
    socket.on("data", chunk => {
      if ((chunk[0]! & 15) === 8) { socket.end(); return }
      const size = chunk[1]! & 127
      const body = Buffer.from(chunk.subarray(6, 6 + size))
      for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ chunk[2 + i % 4]!
      socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]))
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }))
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, streams, upgrades }
}

async function fixture(t: TestContext) {
  const apps = [await appServer(t, "A"), await appServer(t, "B")]
  const remotes = []
  for (const id of ["a", "b"]) {
    const remote = await startRemoteSurface(t, { skipAuth: true, configureApp: app => {
      app.addHook("onSend", (request, _reply, payload, done) => done(null,
        request.url === "/api/meta" ? JSON.stringify({ serverId: id }) : payload))
    } })
    // Fix only the generated receipt identity; exercise the real manager and path proxy.
    const manager = remote.previewManager, create = manager.create.bind(manager)
    manager.create = (sessionId, url) => {
      const receipt = create(sessionId, url.replace("http://app.invalid", apps[id === "a" ? 0 : 1]!.origin))
      const records = (manager as any).previews as Map<string, any>
      const record = records.get(receipt.token)
      records.delete(receipt.token)
      record.token = TOKEN
      records.set(TOKEN, record)
      return manager.get(TOKEN)!
    }
    remotes.push(remote)
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remote-preview-browser-"))
  const profiles = remotes.map((remote, i) => ({ id: i ? "b" : "a", baseUrl: `http://${remote.local}` }))
  const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(directory, "config.yaml") }
  const manager = new RemoteServerBrowseManager(settings), server = Fastify()
  let origin = ""
  const getSelfOrigins = () => new Set([origin])
  registerBackendRelayRoutes(server, { manager, getSelfOrigins })
  registerRemotePreviewCapabilityRoutes(server, { manager, getSelfOrigins, logger: pino({ level: "silent" }) })
  server.get("/api/ui-secret", (request, reply) => { if (!guardLocalBackendCaller(request, reply, getSelfOrigins())) return { secret: "UI-only" } })
  const borrowed = await borrowFixture({ name: "remote-preview-capabilities", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script>window.EventSource=class extends EventTarget{close(){}}</script><script type="module" src="/tests/browser/fixtures/remote-preview-capabilities.tsx"></script></body></html>' }] })
  server.setNotFoundHandler(async (request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) return reply.code(404).send()
    const response = await fetch(new URL(request.url, borrowed.url))
    reply.code(response.status).header("content-type", response.headers.get("content-type") ?? "text/plain")
    return reply.send(Buffer.from(await response.arrayBuffer()))
  })
  await server.listen({ host: "127.0.0.1", port: 0 })
  origin = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  t.after(async () => {
    await browser.close()
    await server.close()
    manager.close()
    await borrowed.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  await page.goto(new URL(new URL(borrowed.url).pathname, origin).href)
  await page.locator('[data-owner="a"] iframe').waitFor()
  await page.locator('[data-owner="b"] iframe').waitFor()
  return { page, origin, apps, manager, profiles, errors }
}

const section = (page: Page, id: string) => page.locator(`[data-owner="${id}"]`)
const appFrame = (page: Page, id: string) => page.frameLocator(`[data-owner="${id}"] iframe`)
async function ready(page: Page) {
  for (const [id, label] of [["a", "A"], ["b", "B"]]) {
    await appFrame(page, id!).locator("#asset").filter({ hasText: `asset-${label}` }).waitFor()
    await appFrame(page, id!).locator("#fetch").filter({ hasText: `fetch-${label}` }).waitFor()
    await appFrame(page, id!).locator("#ws").filter({ hasText: `${label}:hmr` }).waitFor()
  }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) assert.fail("Stream did not close"); await new Promise(resolve => setTimeout(resolve, 20)) }
}

test("two real remote apps load HTML/assets/fetch/WS and retain only logical addresses through navigation/history/reload", async t => {
  const f = await fixture(t)
  await ready(f.page)
  assert.equal(await appFrame(f.page, "a").locator("h1").evaluate(element => getComputedStyle(element).color), "rgb(10, 20, 30)")
  const initial = await section(f.page, "a").locator("iframe").getAttribute("src")
  assert.match(initial!, /\.preview\.localhost:\d+\/previews\//)
  assert.equal(await section(f.page, "a").locator("input").inputValue(), `${f.apps[0]!.origin}/start`)
  await appFrame(f.page, "a").locator("a").click()
  await f.page.waitForFunction(() => document.querySelector<HTMLInputElement>('[data-owner="a"] input')?.value.endsWith("/next?q=1#part"))
  await section(f.page, "a").getByRole("button", { name: "Back", exact: true }).click()
  await f.page.waitForFunction(() => document.querySelector<HTMLInputElement>('[data-owner="a"] input')?.value.endsWith("/start"))
  await section(f.page, "a").getByRole("button", { name: "Forward", exact: true }).click()
  await f.page.waitForFunction(() => document.querySelector<HTMLInputElement>('[data-owner="a"] input')?.value.endsWith("/next?q=1#part"))
  const document = await appFrame(f.page, "a").locator("h1").getAttribute("data-page")
  await section(f.page, "a").getByRole("button", { name: "Refresh", exact: true }).click()
  await appFrame(f.page, "a").locator(`h1:not([data-page="${document}"])`).waitFor()
  assert.ok((await section(f.page, "a").locator("input").inputValue()).endsWith("/next?q=1#part"))
  const history = await f.page.evaluate(() => (window as any).remotePreviews.history("a"))
  assert.ok(history.urls.every((url: string) => !url.includes(".preview.localhost")))
  assert.deepEqual(f.errors, [])
})

test("hostile content cannot read its parent, local UI/relay or the other known capability", async t => {
  const f = await fixture(t)
  await ready(f.page)
  const frames = f.page.frames()
  const source = await f.page.evaluate(() => (window as any).remotePreviews.source("a"))
  const hostile = frames.find(frame => frame.url().startsWith(new URL(source).origin))!
  assert.equal(await hostile.evaluate(() => { try { return parent.document.body.innerText } catch { return "blocked" } }), "blocked")
  const other = await f.page.evaluate(() => (window as any).remotePreviews.source("b"))
  for (const url of [`${f.origin}/api/ui-secret`, `${f.origin}/api/backends/b/api/meta`, new URL("/data", other).href]) {
    assert.equal(await hostile.evaluate(url => (window as any).attack(url), url), "blocked")
  }
  assert.deepEqual(f.errors, [])
})

for (const action of ["close", "tab", "detach", "remove", "retarget", "shutdown"] as const) {
  test(`${action} cuts remote HTTP/WS streams and removes the live guest`, async t => {
    const f = await fixture(t)
    await ready(f.page)
    assert.equal(f.apps[0]!.streams.size, 1)
    assert.equal(f.apps[0]!.upgrades.size, 1)
    if (action === "close") await section(f.page, "a").getByRole("button", { name: "Close", exact: true }).click()
    if (action === "tab") await f.page.evaluate(() => (window as any).remotePreviews.closeTab("a"))
    if (action === "detach") await f.page.evaluate(() => (window as any).remotePreviews.detach("a"))
    if (action === "remove") { f.profiles.splice(0, 1); f.manager.reconcile(); await f.page.evaluate(() => (window as any).remotePreviews.detach("a")) }
    if (action === "retarget") { f.profiles[0]!.baseUrl = f.profiles[1]!.baseUrl; f.manager.reconcile(); await f.page.evaluate(() => (window as any).remotePreviews.detach("a")) }
    if (action === "shutdown") await f.page.goto("about:blank")
    else await section(f.page, "a").locator("iframe").waitFor({ state: "detached" })
    await until(() => !f.apps[0]!.streams.size && !f.apps[0]!.upgrades.size)
    if (action === "close") {
      await f.page.evaluate(() => (window as any).remotePreviews.open("a"))
      await appFrame(f.page, "a").locator("#ws").filter({ hasText: "A:hmr" }).waitFor()
      assert.equal(await section(f.page, "a").locator("input").inputValue(), `${f.apps[0]!.origin}/start`)
    }
  })
}
