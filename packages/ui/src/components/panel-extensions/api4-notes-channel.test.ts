import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { createRoot } from "solid-js"
import { useApi4Channel } from "./api4-channel"
import { panelExtensionsApi4 } from "../../lib/panel-extensions-api"
import { addInstance } from "../../stores/instances"
import { sdkManager } from "../../lib/sdk-manager"
import { applySurface, getSessionSurface } from "../../stores/session-surface"
import { activeSessionId } from "../../stores/sessions"
import { serverEvents } from "../../lib/server-events"

// The API 4 notes channel: deferred `open` navigation and orphan invalidations.
const current = { instanceId: "notes-channel", sessionId: "ses_work" }
const open = { type: "api4:request", id: 1, capability: "notes", method: "open", input: { sessionID: "ses_other" } }
const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms))

function mount(t: TestContext, notes: (...args: any[]) => Promise<unknown>, instanceId = current.instanceId) {
  t.mock.method(panelExtensionsApi4, "notes", notes as any)
  const reads: string[] = [], sent: unknown[] = []
  const client: any = { session: { get: async ({ sessionID }: { sessionID: string }) => {
    reads.push(sessionID)
    return { id: sessionID, title: "Other", location: { directory: "/repo" }, time: { created: 1, updated: 1 } }
  } } }
  const proxyPath = `/workspaces/${instanceId}/instance`
  ;(sdkManager as any).clients.set(`${instanceId}:${proxyPath}`, client)
  addInstance({ id: instanceId, folder: "/repo", port: 0, pid: 0, proxyPath, status: "ready", client } as any)
  const { receive, dispose } = createRoot(dispose => ({
    receive: useApi4Channel({ instanceId, id: "a.b", digest: "a".repeat(64), name: "Notes", sessionId: current.sessionId,
      permissions: ["session.context", "panel.notes"], send: value => sent.push(value),
      host: { activeSessionId: () => current.sessionId, isPhoneLayout: () => false, closePanel: () => {}, promptInputApi: () => null } }),
    dispose,
  }))
  t.after(dispose)
  return { receive, dispose, reads, sent }
}

test("notes.open: a frame unmounted after the answer never navigates or hydrates", async t => {
  const { receive, dispose, sent, reads } = mount(t, async () => ({ openable: true }))
  await receive(open)
  assert.deepEqual(sent, [{ type: "api4:result", id: 1, result: { opened: true } }])
  dispose()
  await tick()
  assert.notEqual(activeSessionId().get(current.instanceId), "ses_other")
  assert.deepEqual(reads, [])
})

test("notes.open: a user action while the host checks wins over the navigation", async t => {
  let resolve!: (value: unknown) => void
  const { receive } = mount(t, () => new Promise(done => { resolve = done }))
  const pending = receive(open)
  applySurface(current, { kind: "file", target: { sessionId: current.sessionId } } as any)
  resolve({ openable: true })
  await pending
  await tick()
  assert.equal(getSessionSurface(current).kind, "file")
})

test("notes.open: a native generation change or a disconnect after the answer retires the navigation, even once reconnected", async t => {
  for (const change of ["generation", "transport", "reconnect"] as const) {
    const instanceId = `notes-${change}`
    const { receive, reads } = mount(t, async () => ({ openable: true }), instanceId)
    const status = (generation: number) => (serverEvents as any).dispatch({ type: "instance.eventStatus", instanceId, status: "connected", generation })
    status(1)
    await receive(open)
    if (change === "generation") status(2)
    else (serverEvents as any).emitTransportStatus("disconnected")
    if (change === "reconnect") (serverEvents as any).emitTransportStatus("connected")
    await tick()
    assert.notEqual(activeSessionId().get(instanceId), "ses_other", change)
    assert.deepEqual(reads, [], change)
  }
})

test("another instance resynchronizing invalidates notes: it may have missed a deletion", async t => {
  const { sent } = mount(t, async () => ({}), "notes-resync")
  ;(serverEvents as any).dispatch({ type: "instance.eventStatus", instanceId: "notes-other", status: "connected", generation: 3 })
  await tick(400)
  assert.deepEqual(sent, [{ type: "notes:changed" }])
})

test("a session deleted in another instance invalidates notes, never images", async t => {
  const { sent } = mount(t, async () => ({}), "notes-clone")
  ;(serverEvents as any).dispatch({ type: "instance.event", instanceId: "notes-elsewhere", event: { type: "session.deleted", data: { sessionID: "ses_gone" } } })
  await tick(400)
  assert.deepEqual(sent, [{ type: "notes:changed" }])
})
