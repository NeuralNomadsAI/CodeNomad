// Headless comparison of source previews against a recording HTTP/WS upstream on loopback.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer, request } from "node:http"
import { createConnection } from "node:net"
import { gzipSync } from "node:zlib"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

let fixture, target
const sockets = new Set()
const observed = []
export async function ui(root) {
  const dir = path.join(root, "preview-ui")
  await mkdir(dir)
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>Preview fixture</title>")
  return dir
}
export async function configure() {
  fixture = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    observed.push({
      method: req.method, url: req.url, cookie: Boolean(req.headers.cookie), auth: Boolean(req.headers.authorization),
      origin: req.headers.origin, body: Buffer.concat(chunks).toString(),
    })
    res.setHeader("Set-Cookie", ["codenomad_session_1_2=poison", "fixture=value"])
    res.setHeader("X-Frame-Options", "deny")
    res.setHeader("Content-Security-Policy", "default-src 'none'")
    if (req.url.startsWith("/redirect")) { res.writeHead(302, { Location: `${target}/page?after=1` }); return res.end() }
    if (req.url === "/partial") {
      res.writeHead(206, { "Content-Type": "text/html", "Content-Range": "bytes 0-2/5" })
      return res.end("abc")
    }
    if (req.url === "/compressed") {
      res.writeHead(200, { "Content-Type": "text/css", "Content-Encoding": "gzip", ETag: '"original"' })
      return res.end(gzipSync("p{background:url('/a.png')}"))
    }
    if (req.url.startsWith("/app.js")) {
      res.writeHead(200, { "Content-Type": "application/javascript" })
      return res.end('import m from "/other.js";const s="/ordinary";')
    }
    if (req.url.startsWith("/page")) {
      res.writeHead(200, { "Content-Type": "text/html", ETag: '"original"' })
      return res.end('<!doctype html><html><head><script src="/app.js"></script></head><body><img srcset="/a.png 1x, /b.png 2x"></body></html>')
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end('{"fixture":true}')
  }).on("connection", socket => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  }).on("upgrade", (req, socket) => {
    observed.push({ method: req.method, url: req.url, upgrade: true, cookie: Boolean(req.headers.cookie),
      auth: Boolean(req.headers.authorization), origin: req.headers.origin })
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: fixture=value\r\n\r\n`)
    socket.once("data", data => {
      const message = Buffer.from(data.subarray(6))
      for (let i = 0; i < message.length; i++) message[i] ^= data[2 + i % 4]
      socket.end(Buffer.concat([Buffer.from([0x81, message.length]), message]))
    })
  })
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve))
  target = `http://127.0.0.1:${fixture.address().port}`
  return ""
}
export async function close() {
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => fixture ? fixture.close(resolve) : resolve())
}
const picked = ["set-cookie","content-type","content-security-policy","referrer-policy","access-control-allow-origin",
  "access-control-allow-credentials","location","etag","content-range","x-frame-options"]
function send(origin, path, headers = {}, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const req = request(`${origin}${path}`, { method, headers, agent: false }, res => {
      const chunks = []
      res.on("data", chunk => chunks.push(chunk))
      res.on("error", reject)
      res.on("end", () => {
        let body = Buffer.concat(chunks).toString()
        try { body = JSON.parse(body) } catch {}
        resolve({ status: res.statusCode, headers: Object.fromEntries(picked.filter(k => k in res.headers).map(k => [k,res.headers[k]])), body })
      })
    })
    req.setTimeout(20_000, () => req.destroy(Error("Preview request timed out")))
    req.on("error", reject)
    req.end(body)
  })
}
function upgrade(origin, path, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin)
    const socket = createConnection(Number(url.port), "127.0.0.1")
    const lines = [`GET ${path} HTTP/1.1`, `Host: ${url.host}`, "Connection: Upgrade", "Upgrade: websocket",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", ...headers]
    socket.on("connect", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`))
    socket.setTimeout(20_000, () => socket.destroy(Error("Preview upgrade timed out")))
    socket.on("error", reject)
    let buffer = Buffer.alloc(0), head, status, sent = false
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (!head) {
        const first = buffer.indexOf("\r\n\r\n")
        if (first < 0) return
        head = buffer.subarray(0, first).toString()
        status = Number(head.split(" ")[1])
        buffer = buffer.subarray(first + 4)
        if (status !== 101) { resolve({ status }); socket.destroy(); return }
      }
      if (!sent) {
        sent = true
        const data = Buffer.from("round trip")
        socket.write(Buffer.concat([Buffer.from([0x81, data.length | 0x80, 3, 4, 5, 6]), data.map((b,i) => b ^ [3,4,5,6][i % 4])]))
      }
      if (buffer.length >= 12) {
        resolve({ status, echo: buffer.subarray(2, 12).toString(), setCookie: /^set-cookie:/im.test(head) })
        socket.destroy()
      }
    })
    socket.on("close", () => { if (!head) resolve({ status: null }) })
  })
}
export async function run({ call, origin, cookie }) {
  const create = (sessionId, url) => call("/api/previews", { method: "POST", headers: { "content-type":"application/json" }, body: JSON.stringify({ sessionId, url }) })
  const view = await create(" fixture-session ", `${target}/page?show=1#top`)
  assert.equal(view.status, 200)
  const row = await view.json()
  assert.equal(row.sessionId, "fixture-session")
  assert.match(row.token, /^[0-9a-f-]{36}$/)
  assert.equal(row.proxyUrl, `/previews/${row.token}/page?show=1#top`)
  assert.equal(row.targetUrl, `${target}/page?show=1#top`)
  assert(Number.isFinite(Date.parse(row.createdAt)))
  const prefix = `/previews/${row.token}`
  const clean = value => {
    if (typeof value === "string") return value.replaceAll(row.token, "<token>").replaceAll(target, "<target>")
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v)]))
    return value
  }
  const out = { create: clean({ ...row, createdAt: typeof row.createdAt }), invalid: [] }
  for (const [session, url] of [["s", "file:///C:/workspace"], ["s", "http://fixture:synthetic@localhost/app"], [" ", target], ["s", " "]]) {
    const response = await create(session, url)
    out.invalid.push({ status: response.status, body: await response.json() })
  }
  const get = (path, headers) => send(origin, `${prefix}${path}`, headers)
  observed.length = 0
  try {
    out.html = clean(await get("/page?show=1", { origin:"null", cookie, authorization:"Bearer synthetic" }))
    assert.equal(out.html.status, 200)
    assert.match(out.html.body, /codenomad-preview-location/)
    assert.match(out.html.headers["content-security-policy"], /^sandbox /)
    assert.equal(out.html.headers["set-cookie"], undefined)
    assert.equal(out.html.headers.etag, undefined)
    out.js = clean(await get("/app.js"))
    out.css = clean(await get("/compressed"))
    out.redirect = clean(await get("/redirect"))
    out.partial = await get("/partial")
    out.post = await send(origin, `${prefix}/api/test`, { origin:"null", "content-type":"text/plain" }, "POST", "hello")
    out.fallback = clean(await send(origin, "/app.js", { cookie, referer:`${origin}${prefix}/page` }))
    out.host = clean(await send(origin, "/page", { host:`${row.token}.preview.localhost:${new URL(origin).port}` }))
    out.websocket = await upgrade(origin, `${prefix}/ws?x=1`, [`Cookie: ${cookie}`, "Origin: null", "Authorization: Bearer synthetic"])
    assert.deepEqual(out.websocket, { status:101, echo:"round trip", setCookie:false })
    out.upstream = clean(observed.map(x => ({
      ...x, cookie: x.cookie || undefined, auth: x.auth || undefined,
    })))
    assert(observed.every(r => !r.cookie && !r.auth))
  } finally {
    out.remove = (await call(`/api/previews/${row.token}`, { method:"DELETE" })).status
  }
  out.deleteAgain = await call(`/api/previews/${row.token}`, { method:"DELETE" }).then(async r => ({ status:r.status, body:await r.json() }))
  out.after = (await get("/page")).status
  return out
}
