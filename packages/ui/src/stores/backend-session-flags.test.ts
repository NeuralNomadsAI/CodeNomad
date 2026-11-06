import assert from "node:assert/strict"
import { test } from "node:test"
import { backendEvents } from "../lib/backend-events"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance, removeInstance } from "./instances"
import { createSession, deleteSession, isCreatingSession } from "./session-api"
import { loading, sessions, sessionInfoByInstance, setProviders, setSessions } from "./session-state"
import { messageStoreBus } from "./message-v2/bus"
import type { Session } from "../types/session"

const source = {
  on: () => () => {}, onOpen: () => () => {},
  onTransportStatus: () => () => {}, onDispose: () => () => {},
}

function deferred() {
  let resolve!: (value: any) => void
  let reject!: (error: Error) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail("mutation did not dispatch")
}

for (const operation of ["create", "delete"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`${operation} ${outcome}: revoked owner clears only its own loading flag`, async () => {
      // Both sequences use the same backend/client across detach and reattach.
      // First exercise abandoned loading; then keep owner B pending while A settles.
      for (const replacement of [false, true]) {
        const backendId = `flags_${operation}_${outcome}_${replacement}`
        const instanceId = `${backendId}~ws`
        const targetId = "target"
        const requests: ReturnType<typeof deferred>[] = []
        const calls: string[] = []
        const dispatch = () => {
          calls.push(operation)
          const gate = deferred()
          requests.push(gate)
          return gate.promise
        }
        const unexpected = () => { calls.push("follow-up"); throw new Error("unexpected follow-up") }
        const client = { session: {
          create: dispatch, remove: dispatch, get: unexpected, list: unexpected,
          active: unexpected, update: unexpected, prompt: unexpected, interrupt: unexpected,
        } } as any
        let detach = backendEvents.attach(backendId, source)
        ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
        addInstance({ id: instanceId, backendId, folder: "/repo", port: 0, pid: 0,
          proxyPath: "", status: "ready", client })
        setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture",
          models: [{ id: "fixture", providerId: "fixture", name: "Fixture" }] }]))
        const target = { id: targetId, instanceId, title: "Retained", parentId: null,
          agent: "", model: { providerId: "fixture", modelId: "fixture" }, status: "idle",
          location: { directory: "/repo" }, time: { created: 1, updated: 1 } } as Session
        setSessions(previous => new Map(previous).set(instanceId, new Map([[targetId, target]])))
        const start = () => operation === "create" ? createSession(instanceId) : deleteSession(instanceId, targetId)
        const busy = () => operation === "create" ? isCreatingSession(instanceId)
          : loading().deletingSession.get(instanceId)?.has(targetId) ?? false
        try {
          const first = start()
          const firstRejected = assert.rejects(first, outcome === "success" ? /superseded/ : /network failure/)
          assert.equal(busy(), true)
          await until(() => requests.length === 1)
          detach()
          detach = backendEvents.attach(backendId, source)
          const second = replacement ? start() : undefined
          const secondRejected = second ? assert.rejects(second, /owner B failure/) : undefined
          if (replacement) {
            await until(() => requests.length === 2)
            assert.equal(busy(), true, "B owns the flag before A settles")
          }
          if (outcome === "failure") requests[0].reject(new Error("network failure"))
          else requests[0].resolve({ id: "obsolete-created", projectID: "project", title: "Obsolete",
            location: { directory: "/repo" }, time: { created: 1, updated: 1 } })
          await firstRejected
          assert.equal(busy(), replacement, "A releases its own flag without clearing active B")
          assert.equal(sessions().get(instanceId)?.get(targetId), target, "obsolete deletion cannot remove the row")
          assert.equal(sessions().get(instanceId)?.has("obsolete-created"), false, "obsolete creation cannot publish")
          assert.equal(sessionInfoByInstance().get(instanceId)?.has("obsolete-created") ?? false, false)
          assert.deepEqual(calls, Array(replacement ? 2 : 1).fill(operation), "no mutation replay or follow-up")
          if (replacement) {
            requests[1].reject(new Error("owner B failure"))
            await secondRejected
            assert.equal(busy(), false, "B releases its own flag")
          }
        } finally {
          // Settle stubs even when an assertion fails so workers exit naturally.
          for (const request of requests) request.resolve(undefined)
          await new Promise(resolve => setImmediate(resolve))
          detach()
          messageStoreBus.unregisterInstance(instanceId)
          removeInstance(instanceId, { authoritative: false })
          sdkManager.destroyClientsForInstance(instanceId)
          setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
        }
      }
    })
  }
}
