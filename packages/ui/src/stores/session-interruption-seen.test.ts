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
      markSessionInterruptionSeen(instanceId, current())
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), false)
      resolveActive({})
      await active
      await terminal
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), false, "the delayed handler preserves the clear")
      await refreshSessionRuntimeStatus(instanceId)
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), false, "reconnect preserves the clear")
      markSessionInterruptionSeen(instanceId, current())
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

  for (const { name, busy, idle, unseen, started } of [
    { name: "preserves the current clear when held metadata belongs to an intermediate interruption", busy: 25, idle: 30, unseen: false, started: false },
    { name: "keeps the same-run equal busy and idle timestamp cleared", busy: 30, idle: 30, unseen: false, started: false },
    { name: "shows a missed later run when no metadata for the acknowledged interruption ever returns", busy: 35, idle: 40, unseen: true, started: false },
    { name: "shows a missed later interruption after an observed equal-timestamp higher-sequence start", busy: 30, idle: 40, unseen: true, started: true },
  ]) it(name, async () => {
    const instanceId = `seen-held-metadata-${busy}-${idle}`
    let releaseInfo!: (value: unknown) => void
    const heldInfo = new Promise(resolve => { releaseInfo = resolve })
    let requested!: () => void
    const infoRequested = new Promise<void>(resolve => { requested = resolve })
    let reads = 0
    let nativeIdle = idle
    const client = {
      session: {
        active: async () => ({}),
        get: () => {
          if (++reads === 1) { requested(); return heldInfo }
          return Promise.resolve({ ...session({ instanceId }), parentID: undefined, time: { created: 1, updated: nativeIdle, busy, idle: nativeIdle } })
        },
      },
      message: { list: async () => ({ data: [], cursor: {} }) },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions(previous => new Map(previous).set(instanceId, new Map([["session", session({ instanceId })]])))
    const refresh = refreshSessionRuntimeStatus(instanceId)
    const olderInfo = { ...session({ instanceId }), parentID: undefined, time: { created: 1, updated: 20, idle: 20 } }
    try {
      await infoRequested
      await handleNativeSessionEvent(instanceId, {
        id: "current", created: 30, type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 30, version: 1 },
        data: { sessionID: "session", reason: "user" }, location: { directory: "/work" },
      })
      const current = () => sessions().get(instanceId)!.get("session")!
      markSessionInterruptionSeen(instanceId, current())
      assert.deepEqual(captureSeenInterruptions(instanceId, [current()]), { session: 30 })
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), false)
      releaseInfo(olderInfo)
      await refresh
      assert.equal(current().time.idle, 20, "native metadata keeps its existing merge authority")
      const watermarkAfterOlderMetadata = captureSeenInterruptions(instanceId, [current()])
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), false)
      if (started) {
        await handleNativeSessionEvent(instanceId, {
          id: "later-start", created: 30, type: "session.execution.started",
          durable: { aggregateID: "session", seq: 31, version: 1 },
          data: { sessionID: "session" }, location: { directory: "/work" },
        })
        assert.equal(current().status, "working", "the later start has native lifecycle authority")
        assert.deepEqual(captureSeenInterruptions(instanceId, [current()]), { session: 30 }, "a run start preserves the clear watermark")
      }
      await refreshSessionRuntimeStatus(instanceId)
      assert.equal(current().time.idle, idle)
      assert.equal(current().time.busy, busy)
      assert.equal(current().outcome, "interrupted")
      assert.equal(current().generationRecovery, "interrupted")
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), unseen, "only the acknowledged run stays cleared")
      assert.deepEqual(captureSeenInterruptions(instanceId, [current()]), { session: 30 }, "a missed later run is never acknowledged by a refresh")
      assert.deepEqual(watermarkAfterOlderMetadata, { session: 30 }, "older metadata never lowers the acknowledgement")
      nativeIdle = idle + 1
      await refreshSessionRuntimeStatus(instanceId)
      assert.equal(isSessionInterruptionUnseen(instanceId, current()), true, "a genuinely newer native boundary shows again")
    } finally {
      releaseInfo(olderInfo)
      await refresh
      messageStoreBus.unregisterInstance(instanceId)
      setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
      clearInstanceDeletedSessionAuthority(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
      clearInstanceSeenInterruptions(instanceId)
    }
  })

  for (const busy of [25, 30, 35, undefined]) it(`rebinds covering metadata only with an acknowledged run start (busy=${busy})`, () => {
    const instanceId = "seen-confirmed"
    try {
      const previous = session({ instanceId })
      observeSessionInterruption(instanceId, previous, 30)
      markSessionInterruptionSeen(instanceId, previous)
      const confirmed = session({ instanceId, time: { created: 1, updated: 30, idle: 20 } })
      const merged = mergeFetchedSessionRuntimeState(confirmed, previous, previous)!
      assert.deepEqual(captureSeenInterruptions(instanceId, [merged]), { session: 30 })
      assert.equal(isSessionInterruptionUnseen(instanceId, merged), false)
      const covered = mergeFetchedSessionRuntimeState(session({ instanceId, time: { created: 1, updated: 40, busy, idle: 40 } }), merged, merged)!
      const acknowledgedRun = busy !== undefined && busy <= 30
      assert.deepEqual(captureSeenInterruptions(instanceId, [covered]), { session: acknowledgedRun ? 40 : 30 }, "only the acknowledged run can advance the clear")
      assert.equal(isSessionInterruptionUnseen(instanceId, covered), !acknowledgedRun)
      assert.equal(isSessionInterruptionUnseen(instanceId, session({ time: { created: 1, updated: 41, idle: 41 } })), true)
      const settled = session({ instanceId, generationRecovery: null, outcome: "succeeded", time: { created: 1, updated: 42, idle: 42 } })
      mergeFetchedSessionRuntimeState(settled, covered, covered)
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

  it("viewing clears only Idle markers; explicit acknowledgement leaves live/input states alone", () => {
    const instanceId = "seen-viewed"
    const items = [session({ idleSince: 5 }), session({ id: "child", parentId: "session", idleSince: 5 }),
      session({ id: "idle", parentId: "session", idleSince: 5, generationRecovery: null, outcome: "succeeded" }),
      session({ id: "working", status: "working" }), session({ id: "permission", pendingPermission: true }),
      session({ id: "question", pendingForm: true })]
    setSessions(previous => new Map(previous).set(instanceId, new Map(items.map(item => [item.id, item]))))
    try {
      markViewedSessionIdleSeen(instanceId, "session", true)
      assert.equal(isSessionInterruptionUnseen(instanceId, sessions().get(instanceId)!.get("session")!), true)
      assert.equal(isSessionInterruptionUnseen(instanceId, sessions().get(instanceId)!.get("child")!), true)
      assert.equal(sessions().get(instanceId)!.get("session")!.idleSince, null)
      assert.equal(sessions().get(instanceId)!.get("idle")!.idleSince, 5, "unviewed subagent Idle stays")
      markViewedSessionIdleSeen(instanceId, "session", false)
      assert.equal(sessions().get(instanceId)!.get("idle")!.idleSince, null, "viewed subagent Idle clears")
      assert.equal(isSessionInterruptionUnseen(instanceId, sessions().get(instanceId)!.get("child")!), true)
      assert.deepEqual(captureSeenInterruptions(instanceId, items), {}, "viewing writes no interruption watermark")
      for (const item of items) {
        markSessionInterruptionSeen(instanceId, item)
        markSessionIdleSeen(instanceId, item.id)
      }
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
