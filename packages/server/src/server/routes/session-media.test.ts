import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { mediaDigest } from "../../opencode/session-media"
import { registerSessionMediaRoutes } from "./session-media"
import { OpenCodeSharedService } from "../../workspaces/opencode-service"
import { rememberRuntime } from "../../opencode/compatibility/runtime"

const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64")
const uri = `data:image/png;base64,${bytes.toString("base64")}`

async function fixture() {
  const app = Fastify()
  const upstream = Fastify()
  let owned = true, session: any = { id: "s", location: { directory: "/repo" } }
  let afterRead = () => {}
  const message = { id: "msg_2", type: "assistant", content: [
    { type: "text", text: "Reading" },
    { type: "tool", id: "call", name: "read", state: { status: "completed", content: [{ type: "text", text: "ok" }, { type: "file", mime: "image/png", uri }] } },
  ] }
  upstream.get("/api/session/s", async () => ({ data: structuredClone(session) }))
  upstream.get<{ Params: { messageID: string } }>("/api/session/s/message/:messageID", async request => {
    afterRead(); if (request.params.messageID !== message.id) throw new Error("missing")
    return { data: structuredClone(message) }
  })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}` }
  rememberRuntime(endpoint, { version: "2.2.3", pid: 1, discovery: "info" })
  const service = new OpenCodeSharedService()
  await service.endpoint({ kind: "lifecycle", identity: "media-route", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
  const occurrence = new AbortController()
  registerSessionMediaRoutes(app, { workspaceManager: {
    captureWorkspaceOperation: () => ({ signal: occurrence.signal, current: () => { occurrence.signal.throwIfAborted(); return true } }),
    ownsLocation: async () => owned,
    getSharedServiceConnection: () => service.acquire(),
  } as any })
  app.addHook("onClose", async () => { await service.shutdown(); await upstream.close() })
  const url = (overrides: { message?: string; part?: string; index?: string; digest?: string } = {}) =>
    `/api/workspaces/w/session-media/s/${overrides.message ?? "msg_2"}/${overrides.part ?? "1"}/${overrides.index ?? "1"}/${overrides.digest ?? mediaDigest(uri)}`
  return { app, url, ownership: (value: boolean) => { owned = value }, race: (callback: () => void) => { afterRead = callback },
    change: (value: object) => { session = { ...session, ...value } } }
}

test("serves a deferred tool image's exact bytes to its workspace, pinned by digest and undo boundary", async () => {
  const f = await fixture()
  try {
    const served = await f.app.inject(f.url())
    assert.equal(served.statusCode, 200)
    assert.deepEqual(served.rawPayload, bytes)
    assert.equal(served.headers["content-type"], "image/png")
    assert.equal(served.headers["x-content-type-options"], "nosniff")
    assert.equal(served.headers["content-security-policy"], "default-src 'none'; sandbox")
    assert.match(String(served.headers["cache-control"]), /immutable/)

    for (const invalid of [{ part: "x" }, { index: "-1" }, { digest: "abc" }, { digest: "A".repeat(64) }]) {
      assert.equal((await f.app.inject(f.url(invalid))).statusCode, 400)
    }
    for (const missing of [{ digest: "0".repeat(64) }, { index: "0" }, { part: "0" }, { part: "9" }]) {
      assert.equal((await f.app.inject(f.url(missing))).statusCode, 404)
    }
    assert.equal((await f.app.inject(f.url({ message: "msg_9" }))).statusCode, 502)
    f.change({ revert: { messageID: "msg_2" } })
    assert.equal((await f.app.inject(f.url())).statusCode, 404, "an undone message is not history")
    f.change({ revert: { messageID: "msg_3" } })
    assert.equal((await f.app.inject(f.url())).statusCode, 200)
    f.ownership(false)
    assert.equal((await f.app.inject(f.url())).statusCode, 403)
    f.ownership(true)
    f.race(() => f.change({ location: { directory: "/other" } }))
    assert.equal((await f.app.inject(f.url())).statusCode, 409, "a session moved during the read is refused")
  } finally { await f.app.close() }
})
