import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { fetchSessions, refreshSessionRuntimeStatus } from "./session-api.ts"
import { handleNativeSessionEvent } from "./session-events.ts"
import { beginSessionGenerationAdmission, hydrateSessionGenerationRecovery, sessions, setSessions, setSessionStatus } from "./session-state.ts"
import { messageStoreBus } from "./message-v2/bus.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function setup(id: string, outcome?: Session["outcome"]) {
  const info = {
    id: "session", projectID: "project", location: { directory: "/work" }, title: "Session", agent: "build",
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2, idle: 2 }, outcome,
  }
  const originalWorktrees = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/work", kind: "root" }] })
  let reads = 0
  const client = { session: {
    list: async () => ({ data: [info] }),
    active: async (): Promise<Record<string, unknown>> => ({}),
    get: async () => { reads += 1; return info },
    // Any accidental replay/mutation is a test failure.
    prompt: async () => { throw new Error("Recovery must not prompt") },
    interrupt: async () => { throw new Error("Recovery must not interrupt") },
    update: async () => { throw new Error("Recovery must not update") },
  } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client: client as any })
  const baseline = {
    ...info, instanceId: id, parentId: null, model: { providerId: "provider", modelId: "model" },
    status: "idle", runtimeStatusKnown: false, generationRecovery: "pending", outcome: undefined,
  } as Session
  setSessions(previous => new Map(previous).set(id, new Map([[info.id, baseline]])))
  return {
    client, info, baseline, reads: () => reads,
    current: () => sessions().get(id)?.get(info.id),
    cleanup() {
      serverApi.fetchWorktrees = originalWorktrees
      messageStoreBus.unregisterInstance(id)
      setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
      removeInstance(id, { authoritative: false })
      sdkManager.destroyClientsForInstance(id)
    },
  }
}

describe("native-outcome recovery through real session stores", () => {
  for (const outcome of ["succeeded", "failed", "interrupted", undefined] as const) {
    for (const marker of ["working", "interrupted"] as const) {
      it(`hydrates saved ${marker} from ${outcome ?? "unknown"} without inferring interruption`, async () => {
        const id = `recovery-${marker}-${outcome}`
        const fixture = setup(id, outcome)
        try {
          await fetchSessions(id, { strictStatus: true })
          hydrateSessionGenerationRecovery(id, { session: marker })
          const current = fixture.current()
          assert.equal(current?.status, "idle")
          assert.equal(current?.runtimeStatusKnown, true)
          assert.equal(current?.outcome, outcome)
          assert.equal(current?.generationRecovery, outcome === "interrupted" ? "interrupted" : outcome === undefined ? "pending" : null)
        } finally { fixture.cleanup() }
      })
    }
  }

  it("waits for activity authority without discarding the fetched completion", async () => {
    const id = "recovery-delayed-activity"
    const fixture = setup(id, "succeeded")
    const active = deferred<Record<string, unknown>>()
    fixture.client.session.active = () => active.promise
    try {
      await fetchSessions(id)
      assert.equal(fixture.current()?.outcome, "succeeded")
      assert.equal(fixture.current()?.generationRecovery, "pending")
      active.resolve({})
      await new Promise<void>(done => setImmediate(done))
      assert.equal(fixture.current()?.generationRecovery, null)
      assert.equal(fixture.current()?.runtimeStatusKnown, true)
    } finally { active.resolve({}); fixture.cleanup() }
  })

  it("lets active authority clear an earlier native interruption", async () => {
    const id = "recovery-active-over-outcome"
    const fixture = setup(id, "interrupted")
    fixture.client.session.active = async () => ({ session: {} })
    try {
      await fetchSessions(id, { strictStatus: true })
      hydrateSessionGenerationRecovery(id, { session: "interrupted" })
      assert.equal(fixture.current()?.status, "working")
      assert.equal(fixture.current()?.generationRecovery, null)
      assert.equal(fixture.current()?.outcome, undefined)
    } finally { fixture.cleanup() }
  })

  it("keeps newer native activity authoritative over a stale idle fetch", async () => {
    const id = "recovery-native-event-race"
    const fixture = setup(id, "interrupted")
    const active = deferred<Record<string, unknown>>()
    fixture.client.session.active = () => active.promise
    try {
      await fetchSessions(id)
      handleNativeSessionEvent(id, {
        id: "started", type: "session.execution.started", created: 3, data: { sessionID: "session" },
      } as any)
      active.resolve({})
      await new Promise<void>(done => setImmediate(done))
      assert.equal(fixture.current()?.status, "working")
      assert.equal(fixture.current()?.generationRecovery, null)
      assert.equal(fixture.current()?.outcome, undefined)
    } finally { active.resolve({}); fixture.cleanup() }
  })

  it("does not settle a new admission from an earlier idle fetch", async () => {
    const id = "recovery-admission-race"
    const fixture = setup(id, "succeeded")
    const active = deferred<Record<string, unknown>>()
    fixture.client.session.active = () => active.promise
    try {
      await fetchSessions(id)
      const admission = beginSessionGenerationAdmission(id, "session")
      admission.complete()
      active.resolve({})
      await new Promise<void>(done => setImmediate(done))
      assert.equal(fixture.current()?.generationRecovery, "pending")
      assert.equal(fixture.current()?.runtimeStatusKnown, false)
    } finally { active.resolve({}); fixture.cleanup() }
  })

  it("reads the terminal outcome after an active-only liveness gap", async () => {
    const id = "recovery-liveness-outcome"
    const fixture = setup(id, "succeeded")
    try {
      setSessionStatus(id, "session", "working")
      await refreshSessionRuntimeStatus(id)
      assert.equal(fixture.reads(), 1)
      assert.equal(fixture.current()?.status, "idle")
      assert.equal(fixture.current()?.outcome, "succeeded")
      assert.equal(fixture.current()?.generationRecovery, null)
    } finally { fixture.cleanup() }
  })

  it("keeps acknowledged queued input unknown until a new native idle boundary", async () => {
    const id = "recovery-queued-historical-outcome"
    const fixture = setup(id, "succeeded")
    try {
      await fetchSessions(id, { strictStatus: true })
      beginSessionGenerationAdmission(id, "session").complete()
      assert.equal(fixture.current()?.outcome, undefined)
      await fetchSessions(id, { strictStatus: true })
      assert.equal(fixture.current()?.generationRecovery, "pending")
      assert.equal(fixture.current()?.outcome, undefined)
      fixture.info.time = { created: 1, updated: 4, idle: 4 }
      await fetchSessions(id, { strictStatus: true })
      assert.equal(fixture.current()?.generationRecovery, null)
      assert.equal(fixture.current()?.outcome, "succeeded")
    } finally { fixture.cleanup() }
  })

  it("fences an outcome lookup superseded by native work", async () => {
    const id = "recovery-liveness-race"
    const fixture = setup(id, "interrupted")
    const info = deferred<typeof fixture.info>()
    const started = deferred<void>()
    fixture.client.session.get = () => { started.resolve(); return info.promise }
    try {
      const refresh = refreshSessionRuntimeStatus(id)
      await started.promise
      setSessionStatus(id, "session", "working")
      info.resolve(fixture.info)
      await refresh
      assert.equal(fixture.current()?.status, "working")
      assert.equal(fixture.current()?.outcome, undefined)
      assert.equal(fixture.current()?.generationRecovery, null)
    } finally { info.resolve(fixture.info); fixture.cleanup() }
  })

  for (const refresh of ["list", "runtime"] as const) {
    it(`preserves the admission boundary through a failed activity read and later ${refresh} reconciliation`, async () => {
      const id = `recovery-failed-activity-${refresh}`
      const fixture = setup(id, "succeeded")
      try {
        await fetchSessions(id, { strictStatus: true })
        beginSessionGenerationAdmission(id, "session").complete()
        assert.equal(fixture.current()?.generationAdmissionIdleBoundary, 2)
        fixture.info.time = { created: 1, updated: 4, idle: 4 }
        fixture.client.session.active = async () => { throw new Error("private unavailable activity") }
        await fetchSessions(id, { strictStatus: true }) // Activity failure preserves the published list.
        assert.equal(fixture.current()?.time.idle, 4, "metadata remains non-blocking")
        assert.equal(fixture.current()?.generationRecovery, "pending", "outcome alone cannot settle admission")
        assert.equal(fixture.current()?.generationAdmissionIdleBoundary, 2)
        fixture.client.session.active = async () => ({})
        if (refresh === "list") await fetchSessions(id, { strictStatus: true })
        else await refreshSessionRuntimeStatus(id)
        assert.equal(fixture.current()?.status, "idle")
        assert.equal(fixture.current()?.runtimeStatusKnown, true)
        assert.equal(fixture.current()?.outcome, "succeeded")
        assert.equal(fixture.current()?.generationRecovery, null)
      } finally { fixture.cleanup() }
    })
  }

  it("restores the prior outcome only when a local admission rolls back", async () => {
    const id = "recovery-outcome-rollback"
    const fixture = setup(id, "interrupted")
    try {
      await fetchSessions(id, { strictStatus: true })
      const admission = beginSessionGenerationAdmission(id, "session")
      assert.equal(fixture.current()?.outcome, undefined)
      admission.rollback()
      assert.equal(fixture.current()?.outcome, "interrupted")
      assert.equal(fixture.current()?.generationRecovery, "interrupted")
      assert.equal(fixture.current()?.generationAdmissionEpoch, undefined)
      assert.equal(fixture.current()?.generationAdmissionIdleBoundary, undefined)
    } finally { fixture.cleanup() }
  })

  it("rechecks activity after reading a historical outcome even without SSE", async () => {
    const id = "recovery-liveness-no-sse"
    const fixture = setup(id, "interrupted")
    let reads = 0
    fixture.client.session.active = async () => ++reads === 1 ? {} : { session: {} }
    try {
      await refreshSessionRuntimeStatus(id)
      assert.equal(reads, 2)
      assert.equal(fixture.current()?.status, "working")
      assert.equal(fixture.current()?.outcome, undefined)
      assert.equal(fixture.current()?.generationRecovery, null)
    } finally { fixture.cleanup() }
  })
})
