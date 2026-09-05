import assert from "node:assert/strict"
import test from "node:test"
import worker, { type Env } from "./index"

const DEVICE_COOKIE = `codenomad_remote_device=${"d".repeat(43)}`

function relayEnv(
  onRequest: (request: Request) => Response | Promise<Response>,
  onAsset: (request: Request) => Response | Promise<Response> = () => new Response("asset"),
): Env {
  const stub = { fetch: onRequest }
  return {
    REMOTE_BASE_HOST: "remote.example.com",
    REMOTE_HOSTS: {
      idFromName: (name: string) => name,
      get: () => stub,
    } as unknown as DurableObjectNamespace,
    ASSETS: { fetch: onAsset } as Fetcher,
  }
}

test("remote API paths require a paired session and encrypted tunnel", async () => {
  let forwarded: Request | undefined
  const env = relayEnv((request) => {
    forwarded = request
    return new Response(null, { status: 204 })
  })
  const hostId = "a".repeat(32)
  const response = await worker.fetch(new Request(`https://${hostId}.remote.example.com/api/items?value=1`, { headers: { cookie: DEVICE_COOKIE } }), env)
  assert.equal(response.status, 426)
  assert.equal(forwarded!.headers.get("x-codenomad-relay-operation"), "session-check")
  assert.match(await response.text(), /Encrypted Remote Control tunnel required/)
})

test("remote HTML is authenticated and receives the encrypted transport bootstrap", async () => {
  const hostId = "b".repeat(32)
  const response = await worker.fetch(
    new Request(`https://${hostId}.remote.example.com/`, { headers: { cookie: DEVICE_COOKIE } }),
    relayEnv(
      () => new Response(null, { status: 204 }),
      () => new Response("<!doctype html><html><head></head><body></body></html>", { headers: { "content-type": "text/html" } }),
    ),
  )
  assert.equal(response.status, 200)
  assert.match(await response.text(), /__CODENOMAD_REMOTE_CONTROL__/)
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(response.headers.get("x-frame-options"), "DENY")
})

test("remote tunnel upgrades are routed directly to the host object", async () => {
  let operation: string | null = null
  const hostId = "c".repeat(32)
  const response = await worker.fetch(
    new Request(`https://${hostId}.remote.example.com/__codenomad/tunnel`, { headers: { cookie: DEVICE_COOKIE } }),
    relayEnv((request) => {
      operation = request.headers.get("x-codenomad-relay-operation")
      return new Response("tunnel")
    }),
  )
  assert.equal(await response.text(), "tunnel")
  assert.equal(operation, "tunnel-connect")
})

test("remote HTML is not served before device authentication", async () => {
  const hostId = "0".repeat(32)
  let assetRequests = 0
  const response = await worker.fetch(
    new Request(`https://${hostId}.remote.example.com/`),
    relayEnv(
      () => Response.json({ error: "Remote device is not paired" }, { status: 401 }),
      () => {
        assetRequests += 1
        return new Response("should not be served")
      },
    ),
  )
  assert.equal(response.status, 401)
  assert.equal(assetRequests, 0)
})

test("asset fallback HTML still requires device authentication", async () => {
  const hostId = "2".repeat(32)
  let hostRequests = 0
  const response = await worker.fetch(
    new Request(`https://${hostId}.remote.example.com/missing-route`, { headers: { accept: "*/*", cookie: DEVICE_COOKIE } }),
    relayEnv(
      () => {
        hostRequests += 1
        return Response.json({ error: "Remote device is not paired" }, { status: 401 })
      },
      () => new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } }),
    ),
  )
  assert.equal(response.status, 401)
  assert.equal(hostRequests, 1)
  assert.doesNotMatch(await response.text(), /doctype/)
})

test("immutable UI assets do not wake the host object", async () => {
  const hostId = "1".repeat(32)
  let hostRequests = 0
  const response = await worker.fetch(
    new Request(`https://${hostId}.remote.example.com/assets/app.js`),
    relayEnv(
      () => {
        hostRequests += 1
        return new Response(null, { status: 401 })
      },
      () => new Response("console.log('public bundle')", { headers: { "content-type": "text/javascript" } }),
    ),
  )
  assert.equal(response.status, 200)
  assert.equal(hostRequests, 0)
})

test("remote bootstrap is authenticated and never cached", async () => {
  const hostId = "e".repeat(32)
  const response = await worker.fetch(
    new Request(`https://${hostId}.remote.example.com/__codenomad/bootstrap`, { headers: { cookie: DEVICE_COOKIE } }),
    relayEnv(() => new Response(null, { status: 204 })),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { tunnelPath: "/__codenomad/tunnel" })
  assert.equal(response.headers.get("cache-control"), "no-store")
})

test("host control endpoints are accepted only on the relay base origin", async () => {
  const hostId = "f".repeat(32)
  let forwarded = 0
  const env = relayEnv(() => {
    forwarded += 1
    return new Response(null, { status: 204 })
  })
  const allowed = await worker.fetch(new Request(`https://remote.example.com/api/hosts/${hostId}/devices`), env)
  assert.equal(allowed.status, 204)
  const blocked = await worker.fetch(new Request(`https://ui.example.com/api/hosts/${hostId}/devices`), env)
  assert.equal(blocked.status, 200)
  assert.equal(forwarded, 1)
})

test("pairing page allows its same-origin exchange, stores the pinned host key, and blocks framing", async () => {
  const hostId = "d".repeat(32)
  const response = await worker.fetch(new Request(`https://${hostId}.remote.example.com/__codenomad/pair`), relayEnv(() => new Response()))
  const policy = response.headers.get("content-security-policy") ?? ""
  const page = await response.text()
  assert.match(policy, /connect-src 'self'/)
  assert.match(policy, /frame-ancestors 'none'/)
  assert.match(page, /codenomad\.remote-control\.host-public-key/)
  assert.match(page, /pairing\.protocol!==2/)
})
