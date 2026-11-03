import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { normalizeRestorableSession } from "./client-state-codec.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { handleNativeSessionEvent } from "./session-events.ts"
import { reconcileFetchedSessionRuntime } from "./session-generation-recovery.ts"
import {
  captureSeenInterruptions, clearInstanceSeenInterruptions, hydrateSeenInterruptions,
  isSessionInterruptionUnseen, markSessionInterruptionSeen, observeSessionInterruption,
} from "./session-interruption-seen.ts"
import { clearInstanceDeletedSessionAuthority, markSessionIdleSeen, markViewedSessionIdleSeen, sessions, setSessions } from "./session-state.ts"

const delay = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration))

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
        session(), session({ id: "settled", generationRecovery: null }),
      ])
      assert.deepEqual(captured, { session: 10, settled: 10 })

      const decoded = normalizeRestorableSession({
        activeTabIndex: 0,
        tabs: [{
          kind: "workspace", folder: "/work", drafts: {}, attachments: {}, scrollSnapshots: {},
          unseenIdleSince: {}, generationRecovery: { session: "interrupted" }, seenInterruptions: { ...captured, bad: "x" },
        }],
      })
      const tab = decoded?.tabs[0]
      assert.equal(tab?.kind, "workspace")
      assert.deepEqual(tab?.kind === "workspace" ? { ...tab.seenInterruptions } : null, { session: 10, settled: 10 })

      clearInstanceSeenInterruptions(instanceId)
      assert.equal(isSessionInterruptionUnseen(instanceId, session()), true)
      hydrateSeenInterruptions(instanceId, tab?.kind === "workspace" ? tab.seenInterruptions : undefined)
      assert.equal(isSessionInterruptionUnseen(instanceId, session()), false, "reload does not resurrect it")
    } finally {
      clearInstanceSeenInterruptions(instanceId)
    }
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
      handleNativeSessionEvent(instanceId, {
        id: "interrupted", created: 3, type: "session.execution.interrupted",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId, reason: "user" }, location: { directory: "/work" },
      })
      await delay(20)
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
