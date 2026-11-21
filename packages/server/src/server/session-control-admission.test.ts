import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "@opencode/client"
import { admitSessionControl, currentSessionControl } from "./session-control-admission"

const session = { id: "ses_one", projectID: "project", location: { directory: "D:/fixture" }, time: { created: 1 } } as Awaited<ReturnType<OpenCodeClient["session"]["get"]>>
function fixture() {
  let reads = 0
  const state = { permission: { id: "per_one", sessionID: session.id }, form: { id: "frm_one", sessionID: session.id, state: { status: "pending" } }, fresh: session }
  const client = { permission: { get: async () => { reads++; return state.permission } },
    session: { get: async () => state.fresh, form: { get: async () => { reads++; return state.form } } } } as unknown as OpenCodeClient
  return { state, client, reads: () => reads, request: { method: "POST", pathname: "/api/session/ses_one/permission/per_one/reply", body: { decision: "once" }, session, client, signal: new AbortController().signal } }
}
test("invalid decisions and interruption bodies fail before native reads", async () => {
  const f = fixture()
  for (const body of [{ decision: "allow" }, { decision: "once", message: 3 }, { decision: "once", message: "x".repeat(4097) }, { decision: "once", extra: true }]) {
    assert.equal((await admitSessionControl({ ...f.request, body }))?.status, 400)
  }
  for (const body of [{ resume: "no" }, { resume: false, extra: true }]) {
    assert.equal((await admitSessionControl({ ...f.request, pathname: "/api/session/ses_one/interrupt", body }))?.status, 400)
  }
  assert.equal(f.reads(), 0)
})
test("exact pending identity and Form state fence stale replies", async () => {
  const f = fixture()
  assert.equal(await admitSessionControl(f.request), undefined)
  f.state.permission.sessionID = "ses_foreign"
  assert.equal((await admitSessionControl(f.request))?.status, 409)
  const request = { ...f.request, pathname: "/api/session/ses_one/form/frm_one", method: "DELETE", body: undefined }
  assert.equal(await admitSessionControl(request), undefined)
  f.state.form.state.status = "answered"
  assert.equal((await admitSessionControl(request))?.status, 409)
})
test("a moved or replaced session fails the final identity check", async () => {
  const f = fixture()
  assert.equal(await currentSessionControl(f.request), true)
  f.state.fresh = { ...session, location: { directory: "D:/foreign" } }
  assert.equal(await currentSessionControl(f.request), false)
  f.state.fresh = { ...session, time: { ...session.time, created: 2 } }
  assert.equal(await currentSessionControl(f.request), false)
})
test("an unavailable pending read stays a failure without exposing its body", async () => {
  const f = fixture()
  f.client.permission.get = async () => { throw new Error("private upstream body") }
  assert.deepEqual(await admitSessionControl(f.request), { status: 502, error: "Workspace instance proxy failed" })
})
