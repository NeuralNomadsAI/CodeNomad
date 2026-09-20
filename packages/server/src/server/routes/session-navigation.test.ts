import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { registerSessionNavigationRoutes } from "./session-navigation"

function fixture() {
  const app = Fastify()
  let owned = true, session: any = { id: "s", projectID: "p", location: { directory: "/repo" } }
  let afterRead = () => {}
  const calls: any[] = []
  registerSessionNavigationRoutes(app, { workspaceManager: {
    ownsLocation: async () => owned,
    getSharedServiceClient: async () => ({ session: { get: async () => structuredClone(session) }, rpc: {
      call: async (input: any) => {
        calls.push(input); afterRead()
        return { output: input.method === "outline" ? { status: "outline", entries: [], total: 0, cursor: null }
          : input.method === "outlinePreview" ? { status: "previews", entries: [] }
          : { status: "window", messages: [], older: null, newer: null, resume: { kind: "latest" }, latest: true } }
      },
    } }) as any,
  } as any })
  return { app, calls, ownership: (value: boolean) => { owned = value }, race: (callback: () => void) => { afterRead = callback },
    change: (value: object) => { session = { ...session, ...value } } }
}
for (const method of ["outline", "window", "outlinePreview"]) test(`${method} validates ownership and fences location, project, revert and inventory changes`, async () => {
  const f = fixture(), url = `/api/workspaces/w/session-history/${method}`
  const payload = { sessionID: "s", ...(method === "window" ? { target: { kind: "around", messageID: "m" } }
    : method === "outlinePreview" ? { messageIDs: ["m"] } : {}) }
  const send = () => f.app.inject({ method: "POST", url, payload })
  try {
    for (const extra of [{ directory: "/foreign" }, { databasePath: "x" }, { sql: "SELECT 1" }]) {
      assert.equal((await f.app.inject({ method: "POST", url, payload: { ...payload, ...extra } })).statusCode, 400)
    }
    f.ownership(false)
    assert.equal((await send()).statusCode, 403)
    assert.equal(f.calls.length, 0)
    f.ownership(true)
    assert.equal((await send()).json().status, method === "outlinePreview" ? "previews" : method)
    assert.deepEqual(f.calls[0].location, { directory: "/repo" })
    for (const change of [{ location: { directory: "/other" } }, { projectID: "clone" }, { revert: { messageID: "m" } }]) {
      f.race(() => f.change(change))
      assert.deepEqual((await send()).json(), { status: "blocked", reason: "conflict" })
    }
    f.race(() => f.ownership(false))
    assert.deepEqual((await send()).json(), { status: "blocked", reason: "conflict" })
  } finally { await f.app.close() }
})
