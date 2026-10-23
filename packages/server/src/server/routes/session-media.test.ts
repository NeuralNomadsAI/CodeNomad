import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { mediaDigest } from "../../opencode/session-media"
import { registerSessionMediaRoutes } from "./session-media"

const bytes = Buffer.from(Array.from({ length: 48 * 1024 }, (_, index) => index % 251))
const uri = `data:image/png;base64,${bytes.toString("base64")}`

function fixture() {
  const app = Fastify()
  let owned = true, session: any = { id: "s", location: { directory: "/repo" } }
  let afterRead = () => {}
  const message = { id: "msg_2", type: "assistant", content: [
    { type: "text", text: "Reading" },
    { type: "tool", id: "call", name: "read", state: { status: "completed", content: [{ type: "text", text: "ok" }, { type: "file", mime: "image/png", uri }] } },
  ] }
  registerSessionMediaRoutes(app, { workspaceManager: {
    ownsLocation: async () => owned,
    getSharedServiceClient: async () => ({ session: {
      get: async () => structuredClone(session),
      message: { get: async ({ messageID }: any) => { afterRead(); if (messageID !== message.id) throw new Error("missing"); return structuredClone(message) } },
    } }) as any,
  } as any })
  const url = (overrides: { message?: string; part?: string; index?: string; digest?: string } = {}) =>
    `/api/workspaces/w/session-media/s/${overrides.message ?? "msg_2"}/${overrides.part ?? "1"}/${overrides.index ?? "1"}/${overrides.digest ?? mediaDigest(uri)}`
  return { app, url, ownership: (value: boolean) => { owned = value }, race: (callback: () => void) => { afterRead = callback },
    change: (value: object) => { session = { ...session, ...value } } }
}

test("serves a deferred tool image's exact bytes to its workspace, pinned by digest and undo boundary", async () => {
  const f = fixture()
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
