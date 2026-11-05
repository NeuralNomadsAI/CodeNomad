import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer as httpServer, type Server, type RequestListener } from "node:http"
import { createServer as httpsServer } from "node:https"
import { once } from "node:events"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { createExplicitTransport } from "./transport"

async function fixture(server: Server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  return { port, origin: `http://127.0.0.1:${port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

test("pinned DNS, Basic auth and header filtering preserve native requests", async () => {
  let calls = 0
  const server = await fixture(httpServer((req, res) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("user:synthetic-secret").toString("base64")}`)
    for (const key of ["cookie", "forwarded", "x-forwarded-for", "x-hop"]) assert.equal(req.headers[key], undefined)
    assert.equal(req.headers.host, `localhost:${server.port}`)
    assert.equal(req.headers["x-opencode-directory"], "%2Fworkspace")
    assert.equal(req.method, "POST")
    assert.equal(req.url, "/api/session/id/prompt?x=1")
    let body = ""
    req.on("data", data => body += data)
    req.on("end", () => {
      assert.equal(body, '{"text":"hello"}')
      res.writeHead(200, { "set-cookie": "secret=hidden", "www-authenticate": "Basic realm=private", "x-native": "kept", "content-type": "application/json" })
      res.end('{"ok":true}')
    })
  }))
  try {
    const transport = createExplicitTransport({ origin: `http://localhost:${server.port}`, credentials: { username: "user", password: "synthetic-secret" } }, async () => {
      calls++
      return [{ address: calls === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }]
    })
    const response = await transport.fetch(`${transport.origin}/api/session/id/prompt?x=1`, { method: "POST", body: '{"text":"hello"}', headers: {
      authorization: "Bearer inbound", cookie: "private", forwarded: "host=evil", "x-forwarded-for": "evil", host: "evil", connection: "x-hop", "x-hop": "private", "x-opencode-directory": "%2Fworkspace",
    } })
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(response.headers.get("set-cookie"), null)
    assert.equal(response.headers.get("www-authenticate"), null)
    assert.equal(response.headers.get("x-native"), "kept")
    assert.equal(calls, 1)
    await assert.rejects(transport.fetch(`${transport.origin}/api/info`), { code: "forbidden_address" })
    assert.equal(calls, 2)
  } finally { await server.close() }
})

test("responses strip hop-by-hop headers and Connection-nominated fields for fetch and probes", async () => {
  const server = await fixture(httpServer((_req, res) => {
    res.writeHead(200, {
      trailer: "X-Trailer", te: "trailers", "proxy-connection": "keep-alive",
      connection: "keep-alive, X-Hop, x-Other-Hop", "keep-alive": "timeout=5",
      "x-hop": "private", "x-other-hop": "private", "x-native": "kept",
    })
    res.end("ok")
  }))
  try {
    const transport = createExplicitTransport({ origin: server.origin })
    for (const read of [() => transport.fetch(`${server.origin}/api/info`), () => transport.probe("/api/info")]) {
      const response = await read()
      assert.equal(response.status, 200)
      assert.equal(await response.text(), "ok")
      for (const name of ["trailer", "te", "proxy-connection", "connection", "keep-alive", "transfer-encoding", "upgrade", "x-hop", "x-other-hop"]) {
        assert.equal(response.headers.get(name), null, name)
      }
      assert.equal(response.headers.get("x-native"), "kept")
    }
  } finally { await server.close() }
})

test("redirects never dispatch to Location or expose upstream secrets", async () => {
  let requests = 0
  const server = await fixture(httpServer((_req, res) => { requests++; res.writeHead(302, { location: "http://user:secret@169.254.169.254/" }); res.end() }))
  try {
    const transport = createExplicitTransport({ origin: server.origin })
    await assert.rejects(transport.probe("/api/info"), { code: "redirect", message: "redirect" })
    assert.equal(requests, 1)
    await assert.rejects(transport.fetch("http://elsewhere.example/api/info"), { code: "invalid_origin" })
    await assert.rejects(transport.probe("/api/session" as never), { code: "probe_path" })
    assert.equal(requests, 1)
  } finally { await server.close() }
})

test("IPv6 loopback and IPv4-mapped literals use the controlled dispatcher", async () => {
  const ipv4 = await fixture(httpServer((_req, res) => res.end("mapped")))
  const ipv6 = httpServer((_req, res) => res.end("ipv6"))
  ipv6.listen(0, "::1")
  await once(ipv6, "listening")
  try {
    const port = (ipv6.address() as { port: number }).port
    const native = createExplicitTransport({ origin: `http://[::1]:${port}` })
    assert.equal(await (await native.probe("/api/info")).text(), "ipv6")
    const mapped = createExplicitTransport({ origin: `http://[::ffff:127.0.0.1]:${ipv4.port}` })
    assert.equal(await (await mapped.probe("/api/info")).text(), "mapped")
  } finally {
    await ipv4.close()
    ipv6.closeAllConnections()
    await new Promise<void>(resolve => ipv6.close(() => resolve()))
  }
})

test("read-only probes bound full body to 8 MiB while regular responses stream", async () => {
  const requests: string[] = []
  const server = await fixture(httpServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    res.writeHead(200)
    res.end(Buffer.alloc(8 * 1024 * 1024 + 1, 97))
  }))
  try {
    const transport = createExplicitTransport({ origin: server.origin })
    await assert.rejects(transport.probe("/openapi.json"), { code: "response_limit" })
    const response = await transport.fetch(`${server.origin}/api/event`)
    assert.equal((await response.arrayBuffer()).byteLength, 8 * 1024 * 1024 + 1)
    assert.deepEqual(requests, ["GET /openapi.json", "GET /api/event"])
  } finally { await server.close() }
})

test("ordinary SSE stays streaming beyond probe deadline and cancellation closes it", async () => {
  let closed: Promise<unknown> | undefined
  const server = await fixture(httpServer((req, res) => {
    closed = once(req.socket, "close")
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("data: first\n\n")
  }))
  try {
    const transport = createExplicitTransport({ origin: server.origin })
    const response = await transport.fetch(`${server.origin}/api/event`)
    const reader = response.body!.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n")
    await delay(5_100)
    await reader.cancel()
    await closed
  } finally { await server.close() }
})

test("authentication status survives without challenge/cookie leakage or inherited auth", async () => {
  const server = await fixture(httpServer((req, res) => {
    assert.equal(req.headers.authorization, undefined)
    assert.equal(req.headers.cookie, undefined)
    res.writeHead(401, { "www-authenticate": "Basic realm=private", "set-cookie": "session=private", "content-type": "application/json" })
    res.end('{"_tag":"Unauthorized"}')
  }))
  try {
    const transport = createExplicitTransport({ origin: server.origin })
    const response = await transport.fetch(`${server.origin}/api/info`, { headers: { authorization: "Bearer private", cookie: "session=private" } })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get("www-authenticate"), null)
    assert.equal(response.headers.get("set-cookie"), null)
    assert.deepEqual(await response.json(), { _tag: "Unauthorized" })
  } finally { await server.close() }
})

test("probe 5s deadline covers DNS, headers and stalled body with cleanup", async () => {
  const server = await fixture(httpServer((_req, res) => { res.writeHead(200); res.write("{") }))
  try {
    const started = Date.now()
    const transport = createExplicitTransport({ origin: server.origin })
    const dns = createExplicitTransport({ origin: "https://stalled.example" }, () => new Promise(() => {}))
    const headers = await fixture(httpServer(() => {}))
    try {
      await Promise.all([
        assert.rejects(transport.probe("/api/info"), { code: "timeout" }),
        assert.rejects(dns.probe("/api/info"), { code: "timeout" }),
        assert.rejects(createExplicitTransport({ origin: headers.origin }).probe("/api/info"), { code: "timeout" }),
      ])
    } finally { await headers.close() }
    assert.ok(Date.now() - started >= 4_900)
    assert.ok(Date.now() - started < 8_000)
  } finally { await server.close() }
})

// Public synthetic fixture identity; never used outside isolated loopback tests.
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgth2e2V4anmz2hOIE
Z0jqcFbjbKt+hpcECO7W7KRStBGhRANCAATD6GhbqP7HMeepEWS+yGNNJ/uxyGKg
0fKjSbqG1B/NOJ5/h/w71ki4pGlXE2MBDmwDxTvftcEFXebkICgs4n5c
-----END PRIVATE KEY-----`
const cert = `-----BEGIN CERTIFICATE-----
MIIBZjCCAQ2gAwIBAgIUc2HhJRjv49wP3w6jX0XqLAdUHogwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTEwMTEzMTgwMloXDTM2MTAyOTEz
MTgwMlowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEw+hoW6j+xzHnqRFkvshjTSf7schioNHyo0m6htQfzTief4f8O9ZIuKRp
VxNjAQ5sA8U737XBBV3m5CAoLOJ+XKM9MDswGgYDVR0RBBMwEYIJbG9jYWxob3N0
hwR/AAABMB0GA1UdDgQWBBRosow4p9y9ZAHwlzkLs4JCWn6AxzAKBggqhkjOPQQD
AgNHADBEAiA2tlXRHGz3ch82/SsBpGFdg/H2GEpEtWJPYKmuWABHawIgcBCQFAhA
dliK0iZIP2tHh2GgVppvNuAOKmL2DSVXOMY=
-----END CERTIFICATE-----`

test("TLS verifies trust and hostname; scoped CA has an explicit diagnostic", async () => {
  let requests = 0
  const handler: RequestListener = (req, res) => {
    requests++
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("user:synthetic-secret").toString("base64")}`)
    res.end("trusted")
  }
  const server = await fixture(httpsServer({ key, cert }, handler))
  const directory = await mkdtemp(join(tmpdir(), "codenomad-explicit-tls-"))
  try {
    const origin = server.origin.replace("http:", "https:")
    await assert.rejects(createExplicitTransport({ origin, credentials: { username: "user", password: "synthetic-secret" } }).probe("/api/info"), { code: "tls", message: "tls" })
    assert.equal(requests, 0)
    assert.throws(() => createExplicitTransport({ origin, ca: cert }), { code: "custom_ca_unsupported" })
    const caPath = join(directory, "fixture.pem")
    await writeFile(caPath, cert)
    // Trust is confined to a child process, exercising the platform CA path without a TLS bypass.
    const code = `import assert from 'node:assert/strict'; import { createExplicitTransport } from './packages/server/src/opencode/servers/transport.ts';
      const t=createExplicitTransport({origin:${JSON.stringify(origin)},credentials:{username:'user',password:'synthetic-secret'}});
      assert.equal(await (await t.probe('/api/info')).text(),'trusted');
      const wrong=createExplicitTransport({origin:'https://wrong.example:${server.port}'},async()=>[{address:'127.0.0.1',family:4}]);
      await assert.rejects(wrong.probe('/api/info'),{code:'tls'});`
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath }, timeout: 15_000 })
    assert.equal(requests, 1)
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
})
