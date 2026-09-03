import assert from "node:assert/strict"
import test from "node:test"
import worker, { type Env } from "./index"

function relayEnv(onRequest: (request: Request) => Response | Promise<Response>): Env {
  const stub = { fetch: onRequest }
  return {
    REMOTE_BASE_HOST: "remote.example.com",
    REMOTE_HOSTS: {
      idFromName: (name: string) => name,
      get: () => stub,
    } as unknown as DurableObjectNamespace,
    ASSETS: { fetch: () => new Response("asset") } as Fetcher,
  }
}

test("relay operations use internal headers without changing remote query parameters", async () => {
  let forwarded: Request | undefined
  const env = relayEnv((request) => {
    forwarded = request
    return new Response("ok")
  })
  const hostId = "a".repeat(32)
  const response = await worker.fetch(new Request(`https://${hostId}.remote.example.com/api/items?operation=client&value=1`), env)
  assert.equal(response.status, 200)
  assert.equal(new URL(forwarded!.url).search, "?operation=client&value=1")
  assert.equal(forwarded!.headers.get("x-codenomad-relay-operation"), "proxy")
})

test("pairing page allows its same-origin exchange and blocks framing", async () => {
  const hostId = "b".repeat(32)
  const response = await worker.fetch(new Request(`https://${hostId}.remote.example.com/__codenomad/pair`), relayEnv(() => new Response()))
  const policy = response.headers.get("content-security-policy") ?? ""
  assert.match(policy, /connect-src 'self'/)
  assert.match(policy, /frame-ancestors 'none'/)
})
