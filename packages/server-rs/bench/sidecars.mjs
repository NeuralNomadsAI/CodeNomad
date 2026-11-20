// Mode `sidecars`: SideCar management (`/api/sidecars`, records seeded in `config.yaml`, zod and
// Fastify refusals) and the proxy against one recording upstream: targets and prefix modes, raw
// paths and queries, parsed bodies, redirects, application cookies both ways, credentials and
// routing headers, this server's own ports, HTTPS without a trusted certificate, a stopped port,
// and WebSocket handshakes (101, a refused handshake, source, session and malformed upgrades).
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import net from "node:net"

let upstream, port, received = [], idle
const sockets = new Set()
const free = async () => {
  const socket = net.createServer()
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve))
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  return port
}
const safeCookies = ["service_login=a=b%2Fc; HttpOnly; Path=/", "theme=dark; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/"]
const unsafeCookies = ["codenomad_session=injected; Path=/", "codenomad_session_1_2=injected", "__Host-codenomad_device=injected", "=nameless", "bad name=x"]
const seen = headers => Object.fromEntries(["cookie", "origin", "host", "authorization", "proxy-authorization", "expect", "x-keep",
  "x-drop", "content-type", "content-length", "transfer-encoding", "upgrade", "sec-websocket-key"].filter(name => headers[name] !== undefined).map(name => [name, headers[name]]))

/** The recording upstream, then the records `config.yaml` holds before either server starts. */
export async function configure() {
  upstream = createServer((request, response) => {
    const chunks = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => {
      received.push({ method: request.method, url: request.url, headers: seen(request.headers), body: Buffer.concat(chunks).toString() })
      const url = new URL(request.url, "http://upstream")
      const reply = (status, headers, body = "") => { response.writeHead(status, headers); response.end(body) }
      if (url.pathname.endsWith("/redirect")) return reply(302, { location: "/landing?x=1" })
      if (url.pathname.endsWith("/absolute")) return reply(301, { location: `http://127.0.0.1:${port}/elsewhere?y=2#z` })
      if (url.pathname.endsWith("/foreign")) return reply(302, { location: "https://example.invalid/a" })
      if (url.pathname.endsWith("/cookies")) return reply(200, { "set-cookie": [...safeCookies, ...unsafeCookies], "set-cookie2": "old=1" }, "cookies")
      reply(200, { "content-type": "application/json", "x-custom": "kept" }, "{\"ok\":true}")
    })
  })
  upstream.on("upgrade", (request, socket) => {
    received.push({ method: request.method, url: request.url, headers: seen(request.headers), upgrade: true })
    const cookies = [...safeCookies, ...unsafeCookies].map(cookie => `Set-Cookie: ${cookie}\r\n`).join("")
    if (request.url.includes("denied")) return socket.end(`HTTP/1.1 403 Forbidden\r\n${cookies}Content-Length: 6\r\nConnection: close\r\n\r\ndenied`)
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${cookies}\r\n`)
    const text = Buffer.from("sidecar-echo")
    socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]))
    socket.on("data", () => {})
    socket.on("error", () => {})
  })
  upstream.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve))
  port = upstream.address().port
  idle = await free()
  return [
    "  sidecars:",
    `    - { id: seeded, kind: port, name: " Seeded ", port: ${port}, insecure: true, prefixMode: preserve }`,
    `    - { id: " spaced ", kind: port, name: Spaced, port: ${port}, insecure: true, createdAt: "2026-01-01T00:00:00.000Z" }`,
    `    - { id: zero, kind: port, name: Zero, port: 0 }`,
    `    - { id: other, kind: socket, name: Other, port: ${port} }`,
    "    - not-a-record",
    "",
  ].join("\n")
}
export async function close() {
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => upstream ? upstream.close(resolve) : resolve())
}

/** One request written as is; the status line, chosen headers and body of the answer. */
function raw(origin, lines, body = "", { upgrade = false } = {}) {
  const { port: target } = new URL(origin)
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(target), "127.0.0.1", () => socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`))
    let data = Buffer.alloc(0)
    const finish = () => {
      socket.destroy()
      const text = data.toString("latin1")
      const end = text.indexOf("\r\n\r\n")
      const head = (end < 0 ? text : text.slice(0, end)).split("\r\n")
      const headers = {}
      for (const line of head.slice(1)) {
        const at = line.indexOf(":")
        const name = line.slice(0, at).toLowerCase()
        if (["set-cookie", "location", "content-type", "x-custom", "upgrade", "sec-websocket-accept"].includes(name)) (headers[name] ??= []).push(line.slice(at + 1).trim())
      }
      let rest = end < 0 ? "" : text.slice(end + 4)
      if (/transfer-encoding: chunked/i.test(head.join("\n"))) {
        let decoded = ""
        for (let at = 0; ;) {
          const line = rest.indexOf("\r\n", at), size = parseInt(rest.slice(at, line), 16)
          if (line < 0 || !size) break
          decoded += rest.slice(line + 2, line + 2 + size)
          at = line + 2 + size + 2
        }
        rest = decoded
      }
      let body = upgrade ? rest.slice(2) : rest
      try { if (!upgrade && body) body = JSON.parse(body) } catch {}
      resolve({ status: Number(head[0].split(" ")[1]), headers, body })
    }
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk])
      const text = data.toString("latin1")
      if (upgrade && text.includes("sidecar-echo")) return finish()
      const end = text.indexOf("\r\n\r\n")
      if (end < 0) return
      const length = /content-length: (\d+)/i.exec(text.slice(0, end))?.[1]
      if (length !== undefined && data.length >= end + 4 + Number(length)) finish()
      if (/transfer-encoding: chunked/i.test(text.slice(0, end)) && text.endsWith("\r\n0\r\n\r\n")) finish()
    })
    socket.on("end", finish)
    socket.on("error", error => error.code === "ECONNRESET" ? finish() : reject(error))
    setTimeout(finish, 8000).unref()
  })
}

export async function run({ call, origin, cookie }) {
  const host = new URL(origin).host, own = Number(new URL(origin).port)
  const scrub = value => {
    if (value === own) return "<own>"
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, ["createdAt", "updatedAt"].includes(key) ? typeof item : scrub(item)]))
    if (typeof value === "string") return value.split(String(port)).join("<port>").split(String(idle)).join("<idle>").split(host).join("<host>")
    return value
  }
  const read = async (route, init = {}) => {
    const response = await call(route, { signal: AbortSignal.timeout(30000), ...init })
    const text = await response.text()
    let body = text
    try { body = text ? JSON.parse(text) : null } catch {}
    return scrub({ status: response.status, body })
  }
  const send = (body, method = "POST", type = "application/json") => ({ method, headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) })
  const out = {}
  const fresh = () => { received = [] }
  const take = () => { const value = scrub(received); fresh(); return value }

  // Management: seeded records, creation, refusals, updates, removal.
  out.seeded = await read("/api/sidecars")
  out.created = await read("/api/sidecars", send({ name: "  Docs App! ", port, insecure: true }))
  out.duplicate = await read("/api/sidecars", send({ name: "docs app", port }))
  out.preserved = await read("/api/sidecars", send({ name: "Kept", port, insecure: true, prefixMode: "preserve" }))
  out.secure = await read("/api/sidecars", send({ name: "Secure", port }))
  out.stopped = await read("/api/sidecars", send({ name: "Stopped", port: idle, insecure: true }))
  out.self = await read("/api/sidecars", send({ name: "Self", port: Number(new URL(origin).port), insecure: true }))
  for (const [key, body] of Object.entries({ empty: {}, symbols: { name: "!!!", port: 1 }, wrong: { kind: "x", name: " ", port: 1.5, insecure: "a", prefixMode: "z" },
    big: { name: "a", port: 1e20 }, array: [], nulls: { name: null, port: true }, list: { name: [], port: [] } }))
    out[`create_${key}`] = await read("/api/sidecars", send(body))
  out.createText = await read("/api/sidecars", send("plain", "POST", "text/plain"))
  out.createBadJson = await read("/api/sidecars", send("{"))
  out.createNoBody = await read("/api/sidecars", { method: "POST" })
  out.createForm = await read("/api/sidecars", send("a=1", "POST", "application/x-www-form-urlencoded"))
  out.renamed = await read("/api/sidecars/stopped", send({ name: " Renamed ", port: idle }, "PUT"))
  out.reset = await read("/api/sidecars/kept", send({}, "PUT"))
  out.restored = await read("/api/sidecars/kept", send({ prefixMode: "preserve", insecure: true }, "PUT"))
  out.updateMissing = await read("/api/sidecars/missing", send({ port: 1 }, "PUT"))
  out.updateInvalid = await read("/api/sidecars/kept", send({ port: "1" }, "PUT"))
  out.removeMissing = await read("/api/sidecars/missing", { method: "DELETE" })
  out.removed = await read("/api/sidecars/stopped", { method: "DELETE" })
  out.listed = await read("/api/sidecars")

  // HTTP proxy: targets, raw paths and queries as the client wrote them.
  fresh()
  const get = (target, headers = []) => raw(origin, [`GET ${target} HTTP/1.1`, `Host: ${host}`, `Cookie: ${cookie}`, "Connection: close", ...headers])
  const targets = ["/sidecars/docs-app", "/sidecars/docs-app/", "/sidecars/docs-app/a/b?q=50%&x=%FF", "/sidecars/docs-app/100%25.json",
    "/sidecars/docs-app/50%25%20off.json", "/sidecars/docs-app/@vite/client", "/sidecars/docs-app/a+b:c,d=e.js", "/sidecars/docs-app/caf%C3%A9.json",
    "/sidecars/docs-app/a;b?c=1", "/sidecars/docs-app/x/../y", "/sidecars/docs-app//double", "/sidecars/docs-app/a%2Fb", `/sidecars/docs-app/${"l".repeat(150)}`,
    "/sidecars/kept/deep/path?k=v", "/sidecars/kept", "/sidecars/seeded/x", "/sidecars/spaced/x", "/sidecars/docs%2Dapp/x", "/sidecars/missing/x",
    "/sidecars/", "/sidecars", "/sidecars?x=1", "/sidecars/docs-app/%E0%A4%A", `/sidecars/${"i".repeat(101)}/x`, `/sidecars/${"i".repeat(100)}/x`]
  out.targets = []
  for (const target of targets) out.targets.push({ target, response: scrub(await get(target)), upstream: take() })
  // `Expect` is dropped as well (unit test): Node answers it with an interim 100 before routing.
  out.headers = { response: scrub(await get("/sidecars/docs-app/h", ["Authorization: Basic eDp5", "Proxy-Authorization: x",
    "X-Keep: 1", "X-Drop: 1", "Connection: close, x-drop", "Origin: " + origin])), upstream: take() }
  out.redirects = []
  for (const route of ["/sidecars/docs-app/redirect", "/sidecars/docs-app/absolute", "/sidecars/docs-app/foreign", "/sidecars/kept/redirect"]) out.redirects.push(scrub(await get(route)))
  fresh()
  // The device cookie (`__Host-`, HTTPS only) never reaches the loopback listener, which Rust refuses (unit test filters it).
  out.cookies = { response: scrub(await raw(origin, ["GET /sidecars/docs-app/cookies HTTP/1.1", `Host: ${host}`, "Connection: close",
    `Cookie: ${cookie}; service_login=a=b%2Fc; codenomad_session_123_456=sibling; theme=dark`])), upstream: take() }
  out.selfProxy = [await get("/sidecars/self/api/meta"), await get("/sidecars/self/index.html"), await get("/sidecars/self/sidecars/x")].map(scrub)
  out.secureProxy = scrub(await get("/sidecars/secure/x"))
  out.listedAfter = await read("/api/sidecars")
  fresh()

  // Bodies as the reference parses them.
  const body = (method, type, payload, extra = []) => raw(origin, [`${method} /sidecars/docs-app/item HTTP/1.1`, `Host: ${host}`, `Cookie: ${cookie}`,
    "Connection: close", ...(type ? [`Content-Type: ${type}`] : []), ...(payload === undefined ? [] : [`Content-Length: ${Buffer.byteLength(payload)}`]), ...extra], payload ?? "")
  out.bodies = []
  for (const [method, type, payload] of [["POST", "application/json", "{ \"b\": 1, \"a\": [1.0, 2e2, \"\\u00e9\"] }"], ["POST", "application/json; charset=utf-8", "{\"x\":true}"],
    ["POST", "application/json", "0"], ["POST", "application/json", "{\"__proto__\":{\"p\":1}}"], ["POST", "application/json", "{"], ["DELETE", "application/json", undefined],
    ["DELETE", "application/json", ""], ["DELETE", "application/json", "{\"id\":1}"], ["OPTIONS", "application/json", undefined], ["POST", "text/plain", "plain body"],
    ["PUT", "text/plain", ""], ["POST", "application/x-www-form-urlencoded", "a=1"], ["POST", undefined, "raw"], ["POST", undefined, undefined],
    ["PROPFIND", "text/plain", "PROPFIND body"], ["UNLOCK", undefined, undefined], ["HEAD", undefined, undefined], ["PATCH", "TEXT/PLAIN", "upper"]])
    out.bodies.push({ method, type, response: scrub(await body(method, type, payload)), upstream: take() })
  // Over Fastify's 1 MiB body limit: the reference's 413 races its socket close (often a reset on Windows).
  out.large = await call("/sidecars/docs-app/item", { method: "POST", headers: { "content-type": "text/plain" }, body: "x".repeat(1024 * 1024 + 1) })
    .then(response => response.status === 413 ? "refused" : response.status, () => "refused")
  take()

  // Admission of the proxy: sources, sessions. A foreign page's GET is refused by Rust's loopback
  // admission (audit M2), so foreign sources are compared on writes.
  out.admission = []
  for (const [method, headers] of [["GET", ["Origin: null"]], ["POST", ["Origin: http://127.0.0.1:1"]], ["POST", [`Referer: http://127.0.0.1:1/page`]],
    ["POST", ["Origin: null"]], ["GET", ["Origin: " + origin]], ["POST", ["Origin: " + origin]]])
    out.admission.push((await raw(origin, [`${method} /sidecars/docs-app/a HTTP/1.1`, `Host: ${host}`, `Cookie: ${cookie}`, "Connection: close", ...headers])).status)
  out.anonymous = (await raw(origin, ["GET /sidecars/docs-app/a HTTP/1.1", `Host: ${host}`, "Connection: close"])).status
  out.anonymousHtml = scrub(await raw(origin, ["GET /sidecars/docs-app/a HTTP/1.1", `Host: ${host}`, "Accept: text/html", "Connection: close"]))
  take()

  // WebSockets.
  const ws = (target, headers = [`Cookie: ${cookie}`]) => raw(origin, [`GET ${target} HTTP/1.1`, `Host: ${host}`, "Upgrade: websocket", "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", ...headers], "", { upgrade: true })
  out.websockets = []
  for (const [target, headers] of [["/sidecars/docs-app/ws?x=1", undefined], ["/sidecars/kept/ws", undefined],
    ["/sidecars/docs-app/ws", [`Cookie: ${cookie}; service_login=a=b%2Fc; codenomad_session_1=s; theme=dark`, "Authorization: Basic eDp5"]],
    ["/sidecars/docs-app/denied", undefined], ["/sidecars/docs-app/ws", []], ["/sidecars/docs-app/ws", [`Cookie: ${cookie}`, "Origin: http://127.0.0.1:1"]],
    ["/sidecars/docs-app/ws", [`Cookie: ${cookie}`, "Origin: null"]], ["/sidecars/missing/ws", undefined], ["/sidecars/self/api/events", undefined],
    ["/sidecars/stopped-gone/ws", undefined]]) {
    const response = scrub(await ws(target, headers))
    const upstream = take()
    // A refusal before any upstream is an empty answer on the reference and a JSON error on Rust: status only.
    out.websockets.push({ target, status: response.status, headers: upstream.length ? response.headers : undefined,
      echo: response.status === 101 ? response.body : undefined, upstream })
  }
  const h2c = await raw(origin, ["GET /sidecars/docs-app/ws HTTP/1.1", `Host: ${host}`, `Cookie: ${cookie}`, "Upgrade: h2c", "Connection: Upgrade", "Connection: close"])
  out.h2c = { status: h2c.status, upstream: take() }
  for (const id of ["docs-app", "kept", "secure", "self", "seeded", "spaced"]) await call(`/api/sidecars/${id}`, { method: "DELETE" })
  out.final = await read("/api/sidecars")
  return out
}
