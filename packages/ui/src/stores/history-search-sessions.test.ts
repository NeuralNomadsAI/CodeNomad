import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot } from "solid-js"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance } from "./instances"
import { createHistorySessionLabels } from "./history-search-sessions"
import { destroyOpenCodeData, getOpenCodeInstanceGeneration } from "./opencode-data"
import { ServerEvents, backendEvents } from "../lib/server-events"
import { registerLocalBackendFixture } from "../../tests/contracts/local-backend-fixture"

const instanceId = "history-labels"
const reads: string[] = []
let read: (sessionID: string, signal: AbortSignal) => Promise<unknown> = () => new Promise(() => {})
const client: any = { session: { get: ({ sessionID }: { sessionID: string }, { signal }: { signal: AbortSignal }) => {
  reads.push(sessionID)
  return read(sessionID, signal)
} } }
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${instanceId}/instance`, status: "ready", client } as any)

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const held = (_id: string, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`)

test("queued label reads follow the visible results and stop when they are hidden", async () => {
  reads.length = 0
  read = held
  await createRoot(async dispose => {
    const labels = createHistorySessionLabels(() => instanceId)
    labels.request(ids("old", 10))
    assert.deepEqual(reads, ids("old", 4), "at most four reads are in flight")
    // A new query keeps the in-flight reads but drops queued sessions it no longer shows.
    labels.request(["new-1"])
    labels.cancel()
    await settle()
    read = async sessionID => ({ title: sessionID })
    labels.request(["new-1"])
    await settle()
    assert.deepEqual(reads, [...ids("old", 4), "new-1"])
    assert.equal(labels.get("new-1")?.title, "new-1")
    labels.cancel()
    labels.request(ids("old", 10).slice(4))
    labels.cancel()
    await settle()
    assert.equal(reads.length, 9, "hidden results abort the reads they started")
    dispose()
  })
})

test("a reconnect while results are hidden discards labels from the old connection", async () => {
  reads.length = 0
  read = async () => ({ title: "Old connection" })
  await createRoot(async dispose => {
    const labels = createHistorySessionLabels(() => instanceId)
    labels.request(["s-1"])
    await settle()
    assert.equal(labels.get("s-1")?.title, "Old connection")
    labels.cancel()
    const generation = getOpenCodeInstanceGeneration(instanceId)
    destroyOpenCodeData(instanceId)
    assert.notEqual(getOpenCodeInstanceGeneration(instanceId), generation)
    // The hidden results effect re-runs on the new generation, then workspace scope returns.
    labels.cancel()
    assert.equal(labels.get("s-1"), undefined)
    read = async () => ({ title: "New connection" })
    labels.request(["s-1"])
    await settle()
    assert.deepEqual(reads, ["s-1", "s-1"])
    assert.equal(labels.get("s-1")?.title, "New connection")
    dispose()
  })
})

test("only a missing session stays unavailable; transient failures retry", async () => {
  reads.length = 0
  read = async sessionID => {
    if (sessionID === "missing") throw Object.assign(new Error("Session not found"), { _tag: "SessionNotFoundError" })
    throw new Error("502 Bad Gateway")
  }
  await createRoot(async dispose => {
    const labels = createHistorySessionLabels(() => instanceId)
    labels.request(["flaky", "missing"])
    await settle()
    assert.equal(labels.get("flaky"), null)
    assert.equal(labels.get("missing"), null)
    read = async sessionID => ({ title: `Title ${sessionID}`, location: { directory: "/repo" } })
    labels.request(["flaky", "missing"])
    await settle()
    assert.deepEqual(reads, ["flaky", "missing", "flaky"])
    assert.deepEqual(labels.get("flaky"), { title: "Title flaky", directory: "/repo" })
    assert.equal(labels.get("missing"), null)
    dispose()
  })
})

test("attachment replacement drops delayed labels and revalidates retained demand", async t => {
  const backendId = "history_labels_remote", instanceId = `${backendId}~ws`
  registerLocalBackendFixture(t, backendId)
  const events = new ServerEvents({ api: { connectEvents: () => ({ close() {} } as EventSource), sendClientConnectionPong: async () => {} },
    auth: { check: async () => {}, onRestored: () => () => false } })
  let detach = backendEvents.attach(backendId, events)
  t.after(() => { detach(); events.dispose() })
  let release!: (value: unknown) => void, reads = 0
  const remoteClient: any = { session: { get: () => ++reads === 1
    ? new Promise(resolve => { release = resolve }) : Promise.resolve({ title: "Replacement" }) } }
  const key = `${instanceId}:/workspaces/ws/instance`
  ;(sdkManager as any).clients.set(key, remoteClient)
  t.after(() => (sdkManager as any).clients.delete(key))
  await createRoot(async dispose => {
    try {
      const labels = createHistorySessionLabels(() => instanceId)
      labels.request(["same"])
      detach()
      detach = backendEvents.attach(backendId, events)
      release({ title: "Retired" })
      await settle()
      assert.equal(labels.get("same"), undefined)
      labels.request(["same"])
      await settle()
      assert.equal(reads, 2)
      assert.equal(labels.get("same")?.title, "Replacement")
    } finally { dispose() }
  })
})
