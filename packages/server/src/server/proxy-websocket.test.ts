import assert from "node:assert/strict"
import http from "node:http"
import dns from "node:dns"
import net from "node:net"
import { once } from "node:events"
import test from "node:test"
import type { Logger } from "../logger"
import { proxyWebSocket } from "./proxy-websocket"
import { sidecarResponseCookies } from "../sidecars/proxy-cookies"
import { guardProxyListener } from "./proxy-destination"

test("parsed upgrade forwarding retains coalesced binary bytes in both directions and closes both peers", { timeout: 10000 }, async () => {
  const sockets = new Set<net.Socket>()
  const upstream = http.createServer(), proxy = http.createServer()
  const earlyClient = Buffer.from([0x82, 0x80, 1, 2, 3, 4]), earlyServer = Buffer.from([0x82, 3, 0, 255, 127])
  let accepted: net.Socket | undefined
  upstream.on("upgrade", (_request, socket, head) => {
    accepted = socket as net.Socket
    socket.on("error", () => {})
    socket.on("end", () => socket.end())
    socket.write(Buffer.concat([Buffer.from("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"), earlyServer]))
    if (head.length) socket.write(head)
    socket.on("data", bytes => socket.write(bytes))
  })
  for (const server of [upstream, proxy]) {
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)) })
    server.listen(0, "127.0.0.1"); await once(server, "listening")
  }
  proxy.on("upgrade", (request, socket, head) => proxyWebSocket({ request, socket: socket as net.Socket, head,
    targetUrl: new URL(`http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}/ws`),
    headers: { connection: "Upgrade", upgrade: "websocket" }, responseHeaders: headers => headers,
    logger: { warn() {} } as unknown as Logger, logContext: {},
  }))
  const client = net.connect((proxy.address() as net.AddressInfo).port, "127.0.0.1")
  try {
    await once(client, "connect")
    client.write(Buffer.concat([Buffer.from("GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"), earlyClient]))
    let bytes = Buffer.alloc(0)
    const expected = Buffer.concat([earlyServer, earlyClient])
    for await (const chunk of client) {
      bytes = Buffer.concat([bytes, chunk])
      const offset = bytes.indexOf("\r\n\r\n")
      if (offset < 0 || bytes.length < offset + 4 + expected.length) continue
      assert.deepEqual(bytes.subarray(offset + 4), expected)
      break
    }
    assert(accepted)
    const closed = once(accepted, "close")
    client.destroy()
    if (!accepted.destroyed) await closed
  } finally {
    client.destroy()
    for (const socket of sockets) socket.destroy()
    await Promise.all([upstream, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  }
})

test("a chunked non-upgrade reply is reframed after cookie filtering", { timeout: 10000 }, async () => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(403, { "Set-Cookie": ["codenomad_session=poison; Path=/", "service=value; Path=/"] })
    response.write("access "); response.end("refused")
  })
  const proxy = http.createServer()
  for (const server of [upstream, proxy]) { server.listen(0, "127.0.0.1"); await once(server, "listening") }
  proxy.on("upgrade", (request, socket, head) => proxyWebSocket({ request, socket: socket as net.Socket, head,
    targetUrl: new URL(`http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}/ws`),
    headers: { connection: "Upgrade", upgrade: "websocket" },
    responseHeaders: headers => sidecarResponseCookies(headers, "codenomad_session"),
    logger: { warn() {} } as unknown as Logger, logContext: {},
  }))
  try {
    const request = http.get(`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}/ws`, { headers: { connection: "Upgrade", upgrade: "websocket" } })
    const [response] = await once(request, "response") as [http.IncomingMessage]
    assert.equal(response.statusCode, 403)
    assert.deepEqual(response.headers["set-cookie"], ["service=value; Path=/"])
    let body = ""
    for await (const chunk of response) body += chunk
    assert.equal(body, "access refused")
  } finally {
    await Promise.all([upstream, proxy].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  }
})

test("only an internal captured connection can dial a protected listener without resolving the declared host", { timeout: 10000 }, async t => {
  const upstream = http.createServer(), proxy = http.createServer()
  const sockets = new Set<net.Socket>()
  let contacts = 0
  let trusted = false
  const controller = new AbortController()
  guardProxyListener(upstream)
  upstream.on("upgrade", (request, socket) => {
    assert.equal(request.headers.host, "remote.invalid:9898")
    socket.on("error", () => {})
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
  })
  for (const server of [upstream, proxy]) {
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
    server.listen(0, "127.0.0.1"); await once(server, "listening")
  }
  upstream.on("connection", () => contacts++)
  const port = (upstream.address() as net.AddressInfo).port
  t.mock.method(dns, "lookup", () => { throw new Error("Captured transport must never resolve the declared hostname") })
  proxy.on("upgrade", (request, socket, head) => proxyWebSocket({
    request, socket: socket as net.Socket, head,
    targetUrl: new URL(trusted ? "http://remote.invalid:9898/ws" : `http://0.0.0.0:${port}/ws`),
    headers: { host: "remote.invalid:9898", connection: "Upgrade", upgrade: "websocket" },
    responseHeaders: headers => headers, logger: { warn() {} } as unknown as Logger, logContext: {},
    ...(trusted ? { connection: { hostname: "127.0.0.1", port }, signal: controller.signal } : {}),
  }))
  const upgrade = () => new Promise<number>((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`, {
      headers: { connection: "Upgrade", upgrade: "websocket" },
    })
    request.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode!) })
    request.on("response", response => { response.resume(); resolve(response.statusCode!) })
    request.on("error", reject)
  })
  try {
    assert.equal(await upgrade(), 404)
    assert.equal(contacts, 0)
    trusted = true
    assert.equal(await upgrade(), 101)
    assert.equal(contacts, 1)
    controller.abort()
    await assert.rejects(upgrade())
    assert.equal(contacts, 1, "revoked capability never dials")
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all([upstream, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  }
})
