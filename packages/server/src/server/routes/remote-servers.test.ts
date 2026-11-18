import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import test from "node:test"
import { fileURLToPath } from "node:url"
import Fastify from "fastify"
import type { Logger } from "../../logger"
import { registerRemoteServerRoutes } from "./remote-servers"

if (process.argv.includes("--probe-child")) {
  await probeEarlyClose()
} else {
  test("remote probe survives excessive content-encodings and an early upstream close", () => {
    // GHSA-xjj6-f33q-929c can terminate the process after fetch rejects.
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--probe-child"], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    })
    assert.ifError(child.error)
    assert.equal(child.status, 0, `Probe child failed (${child.signal}):\n${child.stdout}\n${child.stderr}`)
    assert.match(child.stdout, /probe recovered/)
  })
}

async function probeEarlyClose() {
  const app = Fastify()
  registerRemoteServerRoutes(app, { logger: { warn() {} } as unknown as Logger })
  let requests = 0
  let closed!: () => void
  const socketClosed = new Promise<void>((resolve) => { closed = resolve })
  const upstream = createServer((socket) => {
    socket.on("error", () => {})
    socket.once("data", (request) => {
      assert.match(request.toString(), /^GET \/api\/auth\/status HTTP\/1\.1\r\n/)
      requests += 1
      if (requests === 1) {
        socket.once("close", closed)
        socket.end("HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n")
      } else {
        const body = JSON.stringify({ authenticated: true })
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      }
    })
  })
  await once(upstream.listen(0, "127.0.0.1"), "listening")
  try {
    const address = upstream.address()
    assert.ok(address && typeof address !== "string")
    const payload = { baseUrl: `http://127.0.0.1:${address.port}` }
    const failed = await app.inject({ method: "POST", url: "/api/remote-servers/probe", payload })
    assert.equal(failed.statusCode, 200)
    assert.equal(failed.json().ok, false)
    assert.equal(failed.json().reachable, false)
    assert.ok(failed.json().error)
    await socketClosed
    const healthy = await app.inject({ method: "POST", url: "/api/remote-servers/probe", payload })
    assert.equal(healthy.statusCode, 200)
    assert.equal(healthy.json().ok, true)
    assert.equal(healthy.json().authenticated, true)
    assert.equal(requests, 2)
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
  }
  console.log("probe recovered")
}
