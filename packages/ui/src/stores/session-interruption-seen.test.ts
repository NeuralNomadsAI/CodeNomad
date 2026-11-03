import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { normalizeRestorableSession } from "./client-state-codec.ts"
import { encodeClientSnapshotV2, decodeClientSnapshotV2 } from "./client-state-partitions.ts"
import { refreshSessionRuntimeStatus, removeSessionRuntimeState } from "./session-api.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { handleNativeSessionEvent } from "./session-events.ts"
import { mergeFetchedSessionRuntimeState, reconcileFetchedSessionRuntime } from "./session-generation-recovery.ts"
import {
  captureSeenInterruptions, clearInstanceSeenInterruptions, hydrateSeenInterruptions,
  isSessionInterruptionUnseen, markSessionInterruptionSeen, observeSessionInterruption,
  seenInterruptionsRevision,
} from "./session-interruption-seen.ts"
import { clearInstanceDeletedSessionAuthority, markSessionIdleSeen, markViewedSessionIdleSeen, sessions, setSessions } from "./session-state.ts"

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session", instanceId: "seen", parentId: null, title: "Session", agent: "build",
    model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null,
    idleSince: null, generationRecovery: "interrupted", runtimeStatusKnown: true, outcome: "interrupted",
    projectID: "project", location: { directory: "/work" }, time: { created: 1, updated: 2, idle: 10 },
    ...overrides,
  } as Session
}

describe("seen native interruptions", () => {
  it("hides only the badge until a newer native idle boundary", () => {
    const instanceId = "seen-boundary"
    try {
      const interrupted = session()
      assert.equal(isSessionInterruptionUnseen(instanceId, interrupted), true)
      markSessionInterruptionSeen(instanceId, interrupted)
      assert.equal(isSessionInterruptionUnseen(instanceId, interrupted), false)
      assert.equal(interrupted.generationRecovery, "interrupted", "recovery facts stay native")
      assert.equal(interrupted.outcome, "interrupted")

      const refreshed = reconcileFetchedSessionRuntime(session({ generationRecovery: undefined }), interrupted, {})
      assert.equal(refreshed.generationRecovery, "interrupted")
      assert.equal(isSessionInterruptionUnseen(instanceId, refreshed), false, "a refresh keeps the boundary")

      const later = session({ time: { created: 1, updated: 3, idle: 20 } })
      assert.equal(isSessionInterruptionUnseen(instanceId, later), true, "a newer interruption shows again")
      assert.equal(isSessionInterruptionUnseen(instanceId, session({ generationRecovery: null })), false)
    } finally {
      clearInstanceSeenInterruptions(instanceId)
    }
  })

  it("survives persistence and recovery revalidation", () => {
    const instanceId = "seen-persisted"
    try {
      markSessionInterruptionSeen(instanceId, session())
      markSessionInterruptionSeen(instanceId, session({ id: "settled" }))
      const captured = captureSeenInterruptions(instanceId, [
        session(), session({ id: "settled", generationRecovery: null, outcome: "succeeded", time: { created: 1, updated: 3, idle: 11 } }),
      ])
      assert.deepEqual(captured, { session: 10 })

      const decoded = normalizeRestorableSession({
        activeTabIndex: 0,
        tabs: [{
          kind: "workspace", folder: "/work", drafts: {}, attachments: {}, scrollSnapshots: {},
          unseenIdleSince: {}, generationRecovery: { session: "interrupted" }, seenInterruptions: { ...captured, bad: "x" },
        }],
      })
      const tab = decoded?.tabs[0]
      assert.equal(tab?.kind, "workspace")
      assert.deepEqual(tab?.kind === "workspace" ? { ...tab.seenInterruptions } : null, { session: 10 })

      clearInstanceSeenInterruptions(instanceId)
      assert.equal(isSessionInterruptionUnseen(instanceId, session()), true)
      hydrateSeenInterruptions(instanceId, tab?.kind === "workspace" ? tab.seenInterruptions : undefined)
      assert.equal(isSessionInterruptionUnseen(instanceId, session()), false, "reload does not resurrect it")
    } finally {
      clearInstanceSeenInterruptions(instanceId)
    }
  })

  it("round trips more than 256 acknowledgements independently of draft string budgets", async () => {
    const instanceId = "seen-many"
    try {
      const items = Array.from({ length: 450 }, (_, index) => session({ id: `${index}-${"s".repeat(240)}` }))
      for (const item of items) markSessionInterruptionSeen(instanceId, item)
      const history = Array.from({ length: 300 }, (_, index) => session({ id: `settled-${index}` }))
      for (const item of history) markSessionInterruptionSeen(instanceId, item)
      const captured = captureSeenInterruptions(instanceId, [...history.map(item => ({
        ...item, generationRecovery: null, outcome: "succeeded" as const, time: { ...item.time, idle: 11 },
      })), ...items])
      assert.equal(Object.keys(captured).length, 450, "settled history consumes no allowance")
      const normalized = normalizeRestorableSession({ activeTabIndex: 0, tabs: [{
        kind: "workspace", folder: "/work", drafts: {}, attachments: {}, scrollSnapshots: {},
        unseenIdleSince: {}, generationRecovery: {}, seenInterruptions: captured,
      }] })
      const tab = normalized!.tabs[0]
      assert.equal(tab.kind, "workspace")
      assert.equal(Object.keys(tab.kind === "workspace" ? tab.seenInterruptions! : {}).length, 450)
      const encoded = await encodeClientSnapshotV2({ version: 1, revision: 1, savedAt: 1, layout: {}, session: normalized })
      const decoded = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
      const restored = decoded!.session!.tabs[0]
      assert.equal(restored.kind, "workspace")
      clearInstanceSeenInterruptions(instanceId)
      hydrateSeenInterruptions(instanceId, restored.kind === "workspace" ? restored.seenInterruptions : undefined)
      for (const item of items) assert.equal(isSessionInterruptionUnseen(instanceId, item), false, item.id)
    } finally { clearInstanceSeenInterruptions(instanceId) }
  })

  it("releases both maps on deletion and inventory pruning, preserving unavailable acknowledgements", () => {
    const instanceId = "seen-deleted"
    try {
      for (let index = 0; index < 30; index++) {
        const item = session({ id: `deleted-${index}`, instanceId })
        setSessions(previous => new Map(previous).set(instanceId, new Map([[item.id, item]])))
        observeSessionInterruption(instanceId, item, 20)
        markSessionInterruptionSeen(instanceId, item)
        removeSessionRuntimeState(instanceId, item.id, index % 2 === 0)
        assert.equal(seenInterruptionsRevision().get(instanceId)?.size ?? 0, 0)
        // Reusing the ID at its native boundary detects a retained provisional event boundary.
        const reused = session({ id: item.id, instanceId })
        markSessionInterruptionSeen(instanceId, reused)
        assert.deepEqual(captureSeenInterruptions(instanceId, [reused]), { [item.id]: 10 })
        removeSessionRuntimeState(instanceId, item.id)
      }
      hydrateSeenInterruptions(instanceId, { unavailable: 10 })
      assert.deepEqual(captureSeenInterruptions(instanceId, []), {})
      assert.equal(seenInterruptionsRevision().get(instanceId)?.get("unavailable"), 10)
      assert.equal(isSessionInterruptionUnseen(instanceId, session({ id: "unavailable" })), false)
    } finally {
      messageStoreBus.unregisterInstance(instanceId)
      clearInstanceDeletedSessionAuthority(instanceId)
      clearInstanceSeenInterruptions(instanceId)
      setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
    }
  })

  it("preserves a clear during a held terminal read through reconnect and a real next boundary", async () => {
    const instanceId = "seen-held-event"
    let resolveActive!: (value: Record<string, unknown>) => void
    const active = new Promise<Record<string, unknown>>(resolve => { resolveActive = resolve })
    let reads = 0
    let nativeIdle = 200
    const client = {
      session: {
        active: () => ++reads === 1 ? active : Promise.resolve({}),
        get: async () => ({ ...session({ instanceId }), parentID: undefined, time: { created: 1, updated: nativeIdle, idle: nativeIdle } }),
      },
      message: { list: async () => ({ data: [], cursor: {} }) },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions(previous => new Map(previous).set(instanceId, new Map([["session", session({ instanceId, time: { created: 1, updated: 100, idle: 100 } })]])))
    try {
      const terminal = handleNativeSessionEvent(instanceId, {
        id: "held", created: 200, type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 1, version: 1 },
        data: { sessionID: "session", reason: "user" }, location: { directory: "/work" },
      })
      await refreshSessionRuntimeStatus(instanceId)
      const current = () => sessions().get(instanceId)!.get("session")!
      assert.equal(current().time.idle, 200)
      markSessionIdleSeen(instanceId, "session")
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), false)
      resolveActive({})
      await active
      await terminal
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), false, "the delayed handler preserves the clear")
      await refreshSessionRuntimeStatus(instanceId)
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), false, "reconnect preserves the clear")
      markSessionIdleSeen(instanceId, "session")
      nativeIdle = 201
      await refreshSessionRuntimeStatus(instanceId)
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), true, "a real later boundary is never hidden by an invented one")
    } finally {
      resolveActive({})
      messageStoreBus.unregisterInstance(instanceId)
      setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
      clearInstanceSeenInterruptions(instanceId)
    }
  })

  it("binds a gap-time clear to confirmed metadata rather than an event timestamp", () => {
    const instanceId = "seen-confirmed"
    try {
      const previous = session({ instanceId })
      observeSessionInterruption(instanceId, previous, 30)
      markSessionInterruptionSeen(instanceId, previous)
      const confirmed = session({ instanceId, time: { created: 1, updated: 30, idle: 20 } })
      const merged = mergeFetchedSessionRuntimeState(confirmed, previous, previous)!
      assert.deepEqual(captureSeenInterruptions(instanceId, [merged]), { session: 20 })
      assert.equal(isSessionInterruptionUnseen(instanceId, merged), false)
      assert.equal(isSessionInterruptionUnseen(instanceId, session({ time: { created: 1, updated: 31, idle: 21 } })), true)
      const settled = session({ instanceId, generationRecovery: null, outcome: "succeeded", time: { created: 1, updated: 32, idle: 22 } })
      mergeFetchedSessionRuntimeState(settled, merged, merged)
      assert.equal(seenInterruptionsRevision().get(instanceId)?.size ?? 0, 0)
    } finally { clearInstanceSeenInterruptions(instanceId) }
  })

  it("binds an event acknowledgement before the metadata read and fences late hydration", () => {
    const instanceId = "seen-event-boundary"
    try {
      const interrupted = session()
      markSessionInterruptionSeen(instanceId, interrupted)
      observeSessionInterruption(instanceId, interrupted, 20)
      hydrateSeenInterruptions(instanceId, { session: 100 })
      assert.equal(isSessionInterruptionUnseen(instanceId, interrupted), true)
      markSessionInterruptionSeen(instanceId, interrupted)
      assert.equal(isSessionInterruptionUnseen(instanceId, session({ time: { created: 1, updated: 2, idle: 20 } })), false)
      assert.equal(isSessionInterruptionUnseen(instanceId, session({ time: { created: 1, updated: 2, idle: 21 } })), true)
    } finally { clearInstanceSeenInterruptions(instanceId) }
  })

  it("shares acknowledgement with viewed idle markers and leaves live/input states alone", () => {
    const instanceId = "seen-viewed"
    const items = [session({ idleSince: 5 }), session({ id: "child", parentId: "session", idleSince: 5 }),
      session({ id: "working", status: "working" }), session({ id: "permission", pendingPermission: true }),
      session({ id: "question", pendingForm: true })]
    setSessions(previous => new Map(previous).set(instanceId, new Map(items.map(item => [item.id, item]))))
    try {
      markViewedSessionIdleSeen(instanceId, "session", true)
      assert.equal(isSessionInterruptionUnseen(instanceId, sessions().get(instanceId)!.get("session")!), false)
      assert.equal(isSessionInterruptionUnseen(instanceId, sessions().get(instanceId)!.get("child")!), true)
      markViewedSessionIdleSeen(instanceId, "session", false)
      for (const item of items) markSessionIdleSeen(instanceId, item.id)
      assert.deepEqual(captureSeenInterruptions(instanceId, items), { session: 10, child: 10 })
      assert.equal(sessions().get(instanceId)!.get("session")!.idleSince, null)
    } finally {
      setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceSeenInterruptions(instanceId)
    }
  })

  it("shows a new native interruption event again", async () => {
    const instanceId = "seen-native-event"
    const sessionId = "session"
    const client = {
      session: { active: async () => ({}) },
      message: { list: async () => ({ data: [], cursor: {} }) },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([[sessionId, session({ instanceId })]])))
    try {
      markSessionInterruptionSeen(instanceId, sessions().get(instanceId)!.get(sessionId)!)
      assert.equal(isSessionInterruptionUnseen(instanceId, sessions().get(instanceId)!.get(sessionId)!), false)
      await handleNativeSessionEvent(instanceId, {
        id: "interrupted", created: 3, type: "session.execution.interrupted",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId, reason: "user" }, location: { directory: "/work" },
      })
      const current = sessions().get(instanceId)!.get(sessionId)!
      assert.equal(current.generationRecovery, "interrupted")
      assert.equal(isSessionInterruptionUnseen(instanceId, current), true)
    } finally {
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
      clearInstanceSeenInterruptions(instanceId)
    }
  })
})
