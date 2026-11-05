import assert from "node:assert/strict"
import { it } from "node:test"
import toast from "solid-toast"
import { sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import { getToastHistory, showToastNotification } from "../lib/notifications"
import { addInstance, removeInstance, updateInstance } from "./instances"
import { destroyOpenCodeData } from "./opencode-data"
import { handleNativeSessionEvent, handleSessionCompacted } from "./session-events"
import { fetchSessions } from "./session-api"
import { serializeSessionAction } from "./session-action-queue"
import { reconcileSessionModel } from "./session-model-reconciliation"
import { sessions, setSessions } from "./session-state"
import { preferences } from "./preferences"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const caps = (generation: number): any => ({ generation, features: { worktrees: { state: "unavailable" } } })
const row = (model = "base") => ({ id: "s", title: "s", agent: "build", parentID: null,
  model: { providerID: "p", id: model }, location: { directory: "/Work/" }, time: { created: 1, updated: 1 } })
function fixture(id: string, held = true, serverId = "A") {
  const client: any = { session: { active: async () => ({}), list: async () => ({ data: [row()], cursor: {} }), get: async () => row() } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/Work/", binding: { serverId, directory: "/Work/" }, capabilities: caps(1),
    port: 0, pid: 0, proxyPath: "", status: "ready", client })
  if (held) setSessions(previous => new Map(previous).set(id, new Map([["s", { ...row(), instanceId: id,
    parentId: null, model: { providerId: "p", modelId: "base" }, status: "working", retry: null } as any]])))
  return { id, client, cleanup() {
    removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id); destroyOpenCodeData(id)
    setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
  } }
}
const event = (type: string, data: Record<string, unknown> = {}): any => ({ id: type, type, created: 2,
  location: { directory: "/Work/" }, data: { sessionID: "s", ...data } })
const retry = () => event("session.retry.scheduled", { attempt: 1, at: Date.now() + 10000, error: { message: "old backoff" } })

it("cold model event's second read rejects connection rotation after metadata publication", async () => {
  const f = fixture("continuation-model-cold", false), cold = deferred<any>(), model = deferred<any>(), started = deferred<void>()
  let calls = 0
  f.client.session.get = () => { if (++calls === 1) return cold.promise; started.resolve(); return model.promise }
  try {
    handleNativeSessionEvent(f.id, event("session.model.selected"))
    cold.resolve(row()); await started.promise
    assert.equal(sessions().get(f.id)?.get("s")?.model.modelId, "")
    updateInstance(f.id, { capabilities: caps(2) })
    model.resolve(row("obsolete")); await serializeSessionAction(f.id, "s", async () => {})
    assert.equal(sessions().get(f.id)?.get("s")?.model.modelId, "")
  } finally { cold.resolve(row()); model.resolve(row()); f.cleanup() }
})

for (const phase of ["queued", "dispatched"] as const) for (const retire of ["rotation", "binding", "client", "native", "close"] as const) {
  it(`shared model reconciliation fences ${retire} while ${phase}`, async () => {
    const f = fixture(`continuation-model-${phase}-${retire}`), gate = deferred<void>(), response = deferred<any>(), started = deferred<void>()
    let calls = 0
    f.client.session.get = () => { calls++; started.resolve(); return response.promise }
    const blocking = phase === "queued" ? serializeSessionAction(f.id, "s", () => gate.promise) : Promise.resolve()
    const reading = reconcileSessionModel(f.id, "s")
    try {
      if (phase === "dispatched") await started.promise
      if (retire === "rotation") updateInstance(f.id, { capabilities: caps(2) })
      if (retire === "binding") updateInstance(f.id, { binding: { serverId: "B", directory: "/Work/" } })
      if (retire === "client") updateInstance(f.id, { client: {} as any })
      if (retire === "native") destroyOpenCodeData(f.id)
      if (retire === "close") removeInstance(f.id, { authoritative: false })
      gate.resolve(); response.resolve(row("obsolete")); await reading
      assert.equal(calls, phase === "queued" ? 0 : 1)
      assert.notEqual(sessions().get(f.id)?.get("s")?.model.modelId, "obsolete")
    } finally { gate.resolve(); response.resolve(row()); await blocking; f.cleanup() }
  })
}

it("model reconciliation validates returned identity and exact explicit Location, then recovers", async () => {
  const f = fixture("continuation-model-identity")
  try {
    for (const invalid of [{ ...row("bad"), id: "other" }, { ...row("bad"), location: { directory: "/work/" } },
      { ...row("bad"), location: { directory: "/Work/", workspaceID: "foreign" } }]) {
      f.client.session.get = async () => invalid
      await reconcileSessionModel(f.id, "s")
      assert.equal(sessions().get(f.id)?.get("s")?.model.modelId, "base")
    }
    f.client.session.get = async () => row("current")
    await reconcileSessionModel(f.id, "s")
    assert.equal(sessions().get(f.id)?.get("s")?.model.modelId, "current")
  } finally { f.cleanup() }
})

it("local reconciliation retains its generation-independent capability and Location policy", async () => {
  const f = fixture("continuation-model-local", true, "local-shared"), response = deferred<any>()
  f.client.session.get = () => response.promise
  try {
    const reading = reconcileSessionModel(f.id, "s")
    await tick()
    updateInstance(f.id, { capabilities: caps(2) })
    response.resolve({ ...row("current"), location: { directory: "/local-worktree" } })
    await reading
    assert.equal(sessions().get(f.id)?.get("s")?.model.modelId, "current")
  } finally { response.resolve(row()); f.cleanup() }
})

for (const server of ["A", "local-shared"]) for (const kind of ["terminal", "retry"] as const) {
  it(`cold ${kind} continuation preserves newer same-connection runtime authority on ${server}`, async t => {
    const f = fixture(`continuation-${kind}-${server}`, false, server), metadata = deferred<any>()
    f.client.session.get = () => metadata.promise
    const sink = toast as any, original = sink.custom
    let bubbles = 0
    sink.custom = () => { bubbles++; return "owned-sink" }
    t.after(() => { if (original === undefined) delete sink.custom; else sink.custom = original })
    showToastNotification({ category: "sessions", transient: true, message: "sink positive control", variant: "info" })
    assert.equal(bubbles, 1); bubbles = 0
    try {
      handleNativeSessionEvent(f.id, kind === "terminal" ? event("session.execution.started") : retry())
      await fetchSessions(f.id)
      handleNativeSessionEvent(f.id, event(kind === "terminal" ? "session.execution.succeeded" : "session.execution.started"))
      await tick()
      assert.equal(sessions().get(f.id)?.get("s")?.status, kind === "terminal" ? "idle" : "working")
      assert.equal(sessions().get(f.id)?.get("s")?.retry, null)
      const before = bubbles
      metadata.resolve(row()); await tick()
      assert.equal(sessions().get(f.id)?.get("s")?.status, kind === "terminal" ? "idle" : "working")
      assert.equal(sessions().get(f.id)?.get("s")?.retry, null)
      assert.equal(bubbles, before, "an obsolete retry emits no bubble")
    } finally { metadata.resolve(row()); f.cleanup() }
  })
}

for (const kind of ["working", "retry", "terminal", "compacting"] as const) {
  it(`cold current ${kind} metadata still hydrates and applies its runtime status`, async t => {
    const f = fixture(`continuation-current-${kind}`, false), metadata = deferred<any>()
    const sink = toast as any, original = sink.custom, originalDismiss = sink.dismiss
    let bubbles = 0, dismissed = 0
    sink.custom = () => { bubbles++; return "owned-current-sink" }
    sink.dismiss = () => { dismissed++ }
    t.after(() => {
      if (original === undefined) delete sink.custom; else sink.custom = original
      if (originalDismiss === undefined) delete sink.dismiss; else sink.dismiss = originalDismiss
    })
    showToastNotification({ category: "sessions", transient: true, message: "sink positive control", variant: "info" })
    assert.equal(bubbles, 1); bubbles = 0
    let calls = 0
    f.client.session.get = () => { calls++; return metadata.promise }
    try {
      handleNativeSessionEvent(f.id, kind === "retry" ? retry() : event(kind === "terminal" ? "session.execution.succeeded"
        : kind === "compacting" ? "session.compaction.started" : "session.execution.started"))
      await tick()
      metadata.resolve(row()); await tick()
      assert.equal(calls, 1)
      const session = sessions().get(f.id)?.get("s")
      assert.equal(session?.status, kind === "terminal" ? "idle" : kind === "compacting" ? "compacting" : "working")
      assert.equal(session?.retry?.attempt ?? null, kind === "retry" ? 1 : null)
      assert.equal(bubbles, kind === "retry" ? 1 : 0)
    } finally {
      metadata.resolve(row())
      handleNativeSessionEvent(f.id, event("session.execution.started"))
      assert.equal(dismissed, kind === "retry" ? 1 : 0)
      f.cleanup()
    }
  })
}

it("a shared cold lookup applies the newest event while preserving newly hydrated metadata", async () => {
  const f = fixture("continuation-coalesced", false), metadata = deferred<any>()
  let calls = 0
  f.client.session.get = () => { calls++; return metadata.promise }
  try {
    handleNativeSessionEvent(f.id, retry())
    handleNativeSessionEvent(f.id, event("session.execution.started"))
    metadata.resolve(row()); await tick()
    assert.equal(calls, 1)
    assert.equal(sessions().get(f.id)?.get("s")?.status, "working")
    assert.equal(sessions().get(f.id)?.get("s")?.retry, null)
  } finally { metadata.resolve(row()); f.cleanup() }
})

it("terminal evidence coalesces into an unhydrated startup lookup without losing the session", async () => {
  const f = fixture("continuation-cold-terminal", false), metadata = deferred<any>()
  let calls = 0
  f.client.session.get = () => { calls++; return metadata.promise }
  try {
    handleNativeSessionEvent(f.id, event("session.execution.started"))
    handleNativeSessionEvent(f.id, event("session.execution.succeeded"))
    await tick()
    metadata.resolve(row()); await tick()
    assert.equal(calls, 1)
    assert.equal(sessions().get(f.id)?.get("s")?.status, "idle")
  } finally { metadata.resolve(row()); f.cleanup() }
})

it("a current startup continuation survives hydration and retains a concurrent rename", async () => {
  const f = fixture("continuation-startup-hydrated", false), metadata = deferred<any>()
  f.client.session.get = () => metadata.promise
  try {
    handleNativeSessionEvent(f.id, event("session.execution.started"))
    await fetchSessions(f.id)
    handleNativeSessionEvent(f.id, event("session.renamed", { title: "Current title" }))
    metadata.resolve(row()); await tick()
    assert.equal(sessions().get(f.id)?.get("s")?.title, "Current title")
    assert.equal(sessions().get(f.id)?.get("s")?.status, "working")
  } finally { metadata.resolve(row()); f.cleanup() }
})

it("SSE compactions isolate A/B/local homonyms, deduplicate same-target occurrences and preserve routing", async t => {
  const fixtures = [fixture("continuation-notice-A"), fixture("continuation-notice-A2"),
    fixture("continuation-notice-B", true, "B"), fixture("continuation-notice-local", true, "local-shared")]
  const sink = toast as any, original = sink.custom, originalDismiss = sink.dismiss
  const previousHandler = sseManager.onSessionCompacted
  sseManager.onSessionCompacted = handleSessionCompacted
  const dismissed: string[] = []
  let bubbles = 0
  sink.custom = () => `owned-bubble-${++bubbles}`
  sink.dismiss = (id: string) => { dismissed.push(id) }
  t.after(() => {
    if (original === undefined) delete sink.custom; else sink.custom = original
    if (originalDismiss === undefined) delete sink.dismiss; else sink.dismiss = originalDismiss
    sseManager.onSessionCompacted = previousHandler
    fixtures.forEach(f => f.cleanup())
  })
  showToastNotification({ category: "sessions", transient: true, message: "sink positive control", variant: "info" })
  assert.equal(bubbles, 1); bubbles = 0
  const compact = (seq: number): any => ({ ...event("session.compaction.ended"), durable: { aggregateID: "s", seq, version: 1 } })
  const deliver = (index: number, seq: number) => (sseManager as any).handleEvent(fixtures[index].id, compact(seq))
  deliver(0, 7001); deliver(1, 7001); deliver(2, 7001); deliver(3, 7001)
  assert.equal(bubbles, 3)
  assert.deepEqual(dismissed, [])
  deliver(2, 7002)
  assert.equal(bubbles, 4)
  assert.deepEqual(dismissed, ["owned-bubble-2"], "only B's own bubble is replaced")
  deliver(1, 7001)
  assert.equal(bubbles, 4)

  const routing = preferences().notificationRouting
  const before = getToastHistory().length
  try {
    preferences().notificationRouting = { ...routing, sessions: { screen: false, history: true, system: false } } as any
    deliver(0, 7003)
    assert.equal(bubbles, 4, "category routing suppresses the display")
    assert.equal(getToastHistory().length, before + 1)
  } finally { preferences().notificationRouting = routing }
})
