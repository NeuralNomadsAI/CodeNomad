import assert from "node:assert/strict"
import { test } from "node:test"
import { createServerApi } from "./api-client"
import { createBackendTransport } from "./backend-transport"
import { RemoteServerRequestError } from "./remote-server-request"

test("connect/forget are host-only, cancellable and return only reviewed errors", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  let status = 200, body: unknown = { ok: true, cookie: "must-not-leak" }
  const fetcher: typeof fetch = async (url, init) => { calls.push({ path: String(url), init }); return Response.json(body, { status }) }
  const api = createServerApi({ ...createBackendTransport({ id: "local", baseUrl: "http://127.0.0.1:1234" }), fetch: fetcher })
  const controller = new AbortController()
  assert.deepEqual(await api.connectRemoteServer("a/b", { pairingLink: "secret" }, controller.signal), { ok: true })
  assert.equal(calls[0].path, "http://127.0.0.1:1234/api/remote-servers/a%2Fb/connect")
  assert.equal(calls[0].init?.signal, controller.signal)
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { pairingLink: "secret" })
  await api.forgetRemoteServer("b", controller.signal)
  assert.equal(calls[1].path.endsWith("/b/forget"), true)
  status = 409; body = { error: "pairing_expired", cookie: "secret" }
  await assert.rejects(api.connectRemoteServer("a", {}), error => error instanceof RemoteServerRequestError && error.code === "pairing_expired" && !JSON.stringify(error).includes("secret"))
  body = { error: "secret raw exception" }
  await assert.rejects(api.forgetRemoteServer("a"), { message: "unreachable" })
  const before = calls.length
  controller.abort()
  await assert.rejects(api.forgetRemoteServer("a", controller.signal), { name: "AbortError" })
  const remote = createServerApi({ ...createBackendTransport({ id: "saved", baseUrl: "http://127.0.0.1:1234", relayProfileId: "saved" }), fetch: fetcher })
  await assert.rejects(remote.connectRemoteServer("a", {}), { message: "unknown_server" })
  await assert.rejects(remote.forgetRemoteServer("a"), { message: "unknown_server" })
  assert.equal(calls.length, before)
})

test("browse uses the host transport, retains cancellation and sanitizes refused reads", async () => {
  const controller = new AbortController(), calls: RequestInit[] = []
  let body: unknown = { listing: { entries: [], metadata: { currentPath: "/same" } }, recents: [] }, status = 200
  const api = createServerApi({ ...createBackendTransport({ id: "local", baseUrl: "http://127.0.0.1:1234" }),
    fetch: async (url, init) => {
      assert.equal(String(url), "http://127.0.0.1:1234/api/remote-servers/a/browse")
      calls.push(init!); return Response.json(body, { status })
    } })
  assert.deepEqual(await api.browseRemoteServer("a", "/same", controller.signal), body)
  assert.deepEqual(JSON.parse(calls[0].body as string), { path: "/same" })
  assert.equal(calls[0].signal, controller.signal)
  body = { error: "auth", password: "secret" }; status = 409
  await assert.rejects(api.browseRemoteServer("a"), { message: "auth" })
  body = { cookie: "secret" }; status = 200
  await assert.rejects(api.browseRemoteServer("a"), { message: "unreachable" })
  controller.abort()
  await assert.rejects(api.browseRemoteServer("a", undefined, controller.signal), { name: "AbortError" })
})
