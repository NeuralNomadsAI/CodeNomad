import assert from "node:assert/strict"
import test from "node:test"
import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { assertNativeMissionRecoveryReady } from "./native-recovery-observation"

function fixture() {
  const target = { id: "ses_root", projectID: "project", location: { directory: "/repo" } } as SessionInfo
  const state = { active: {} as Record<string, { type: "running" }>, inbox: [] as unknown[],
    children: [] as SessionInfo[], shells: [] as Array<{ status: string; metadata: Record<string, unknown> }>,
    forms: [] as Array<{ sessionID: string }>, permissions: [] as Array<{ sessionID: string }>, incomplete: false, fail: false,
    childInboxes: {} as Record<string, unknown[]>, failInbox: "", inboxReads: [] as string[] }
  const client = {
    session: { list: async ({ parentID }: { parentID: string }) => ({ data: parentID === target.id ? state.children : [], cursor: { next: state.incomplete ? "cursor" : null } }),
      active: async () => { if (state.fail) throw new Error("secret upstream body"); return state.active }, inbox: { list: async ({ sessionID }: { sessionID: string }) => {
        state.inboxReads.push(sessionID)
        if (state.failInbox === sessionID) throw new Error("secret failed inbox body")
        return sessionID === target.id ? state.inbox : state.childInboxes[sessionID] ?? []
      } } },
    shell: { list: async () => ({ location: target.location, data: state.shells }) },
    form: { list: async () => ({ location: target.location, data: state.forms }) },
    permission: { request: { list: async () => ({ location: target.location, data: state.permissions }) } },
  } as unknown as OpenCodeClient
  return { target, state, read: () => assertNativeMissionRecoveryReady(client, target, new AbortController().signal) }
}

test("native recovery observes actual waits without changing native state", async () => {
  const f = fixture()
  await f.read()
  f.state.active[f.target.id] = { type: "running" }
  await assert.rejects(f.read(), /native work/)
  f.state.active = {}
  f.state.shells = [{ status: "running", metadata: {} }]
  await assert.rejects(f.read(), /native work/, "uncorrelated live shells do not establish idle")
  f.state.shells = [{ status: "running", metadata: { sessionID: "ses_unrelated" } }]
  await f.read()
  f.state.forms = [{ sessionID: f.target.id }]
  await assert.rejects(f.read(), /native work/)
})

test("running descendants block a nudge, but completed native children do not", async () => {
  const f = fixture()
  f.state.children = [{ ...f.target, id: "ses_child", parentID: f.target.id }]
  await f.read()
  f.state.active.ses_child = { type: "running" }
  await assert.rejects(f.read(), /native work/)
  f.state.active = {}
  f.state.permissions = [{ sessionID: "ses_child" }]
  await assert.rejects(f.read(), /native work/)
})

test("idle descendants with durable inbox work are not finished, and failed child reads are unknown", async () => {
  const f = fixture()
  f.state.children = [{ ...f.target, id: "ses_child", parentID: f.target.id }]
  f.state.childInboxes.ses_child = [{ id: "msg_child_work" }]
  await assert.rejects(f.read(), /native work/)
  assert.deepEqual(f.state.inboxReads.sort(), ["ses_child", "ses_root"])
  f.state.childInboxes.ses_child = []
  f.state.failInbox = "ses_child"
  await assert.rejects(f.read(), error => error instanceof Error && error.message.includes("unknown") && !error.message.includes("secret"))
})

test("location-global native decisions block recovery without pretending they are unrelated", async () => {
  const f = fixture()
  f.state.forms = [{ sessionID: "global" }]
  await assert.rejects(f.read(), /native work/)
  f.state.forms = []
  f.state.permissions = [{ sessionID: "global" }]
  await assert.rejects(f.read(), /native work/)
})

test("incomplete, moved, or failed observations are unknown and redact native errors", async () => {
  const f = fixture()
  f.state.incomplete = true
  await assert.rejects(f.read(), /unknown/)
  f.state.incomplete = false
  f.state.children = [{ ...f.target, id: "ses_child", parentID: f.target.id, location: { directory: "/foreign" } }]
  await assert.rejects(f.read(), /unknown/)
  f.state.children = []
  f.state.fail = true
  await assert.rejects(f.read(), error => error instanceof Error && error.message.includes("unknown") && !error.message.includes("secret"))
})
