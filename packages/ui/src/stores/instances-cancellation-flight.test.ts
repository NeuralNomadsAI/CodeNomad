import assert from "node:assert/strict"
import { it } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createBackendClient, registerBackendClient } from "../lib/backend-client.ts"
import { backendEvents } from "../lib/backend-events.ts"
import { preferences } from "./preferences.tsx"
import { createInstance, instances, removeInstance, type WorkspaceCreationOwnership } from "./instances.ts"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { resolve, promise }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

for (const mode of ["resolved", "retired", "lost-response", "lost-response-success"] as const) {
  it(`${mode}: cancellation observations share one bounded flight and resume after failure`, async t => {
    const prior = preferences().multiBackend
    preferences().multiBackend = true
    const id = `cancel-flight-${mode}`
    const firstEntered = deferred(), firstGate = deferred(), resumeEntered = deferred(), resumeGate = deferred()
    let original!: WorkspaceCreationOwnership, replacement!: WorkspaceCreationOwnership
    let receipts!: Map<string, { backendId: string }>
    let requestId = "", sequence = 0, attempts = 0, acks = 0, offline = true, holdFirst = true
    const set = Map.prototype.set
    t.mock.method(Map.prototype, "set", function(this: Map<unknown, unknown>, key: unknown, value: any) {
      if (value?.backendId === id && value.api && value.requestKey) receipts = this as typeof receipts
      return set.call(this, key, value)
    })
    const client = createBackendClient({
      id, baseUrl: "https://cancel-flight.invalid", relayProfileId: id, bindRelayAuthority: true,
      fetcher: async (input, init) => {
        const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body ?? "{}"))
        if (path.endsWith("/creation/cancel")) {
          assert.equal(body.requestId, requestId)
          attempts++
          if (holdFirst) { holdFirst = false; firstEntered.resolve(); await firstGate.promise }
          if (offline) return Response.json({}, { status: 503 })
          resumeEntered.resolve(); await resumeGate.promise; acks++
          return Response.json({})
        }
        if (path.endsWith("/creation/release")) return Response.json({})
        if (!path.endsWith("/api/workspaces") || init?.method !== "POST") return Response.json([])
        sequence++; requestId ||= body.requestId
        if (mode.startsWith("lost-response")) throw new TypeError("lost create ACK")
        return Response.json({ id: "w", requestId: body.requestId, path: "/same", binaryLabel: `occurrence-${sequence}`, status: "starting", proxyPath: "", createdAt: "", updatedAt: "" })
      },
    })
    client.admitRelayAuthority!("a".repeat(43))
    const remove = registerBackendClient(client), detach = backendEvents.attach(id, client.events)
    t.after(() => {
      firstGate.resolve(); resumeGate.resolve(); detach(); remove(); client.events.dispose()
      preferences().multiBackend = prior
      removeInstance(`${id}~w`, { authoritative: false })
    })
    const retained = () => [...receipts.values()].filter(value => value.backendId === id).length
    const opening = createInstance("/same", undefined, { backend: client, signal: new AbortController().signal, onCreation: owner => { original = owner } })
    if (mode.startsWith("lost-response")) await assert.rejects(opening); else await opening
    if (mode === "retired") await createInstance("/same", undefined, { backend: client, signal: new AbortController().signal, onCreation: owner => { replacement = owner } })
    const observe = () => (client.events as any).dispatch({ type: "workspace.created", workspace: { id: "w", requestId, path: "/same", binaryLabel: "old-event", status: "starting", proxyPath: "", createdAt: "", updatedAt: "" } })
    const initial = original.discard()
    await firstEntered.promise
    for (let i = 0; i < 50; i++) observe()
    const concurrent = original.discard()
    await tick()
    const duringFirst = attempts
    if (mode === "lost-response-success") {
      offline = false; resumeGate.resolve(); firstGate.resolve()
      await Promise.all([initial, concurrent]); await delay(4000)
      assert.equal(acks, 1, "confirmed settlement fences both cancellation paths")
      assert.equal(attempts, 1, "no attempt follows the cancellation ACK")
    } else {
      firstGate.resolve()
      await Promise.all([initial, concurrent]); await delay(4000)
      assert.equal(retained(), mode === "retired" ? 2 : 1)
      assert.equal(duringFirst, 1, "observations join direct cancellation")
      assert.equal(attempts, 4, "failed trigger exhausts four attempts then stays quiet")
      for (let i = 0; i < 50; i++) observe()
      await delay(7500)
      assert.equal(attempts, 8, "a fresh observation retries with one bounded flight")
      offline = false
      observe(); observe()
      const resumed = Promise.all([original.discard(), original.discard()])
      await resumeEntered.promise; await tick()
      assert.equal(attempts, 9)
      resumeGate.resolve(); await resumed; await tick()
      assert.equal(acks, 1)
      assert.equal(retained(), mode === "retired" ? 1 : 0)
    }
    if (mode === "retired") {
      assert.equal(instances().get(`${id}~w`)?.binaryLabel, "occurrence-2")
      assert.equal(replacement.current(`${id}~w`), true)
      await replacement.release()
    }
    const settledAttempts = attempts
    for (let i = 0; i < 50; i++) observe()
    await original.discard(); await tick()
    assert.equal(attempts, settledAttempts)
    assert.equal(retained(), 0)
  })
}
