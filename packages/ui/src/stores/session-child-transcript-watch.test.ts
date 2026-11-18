import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { EventManifest } from "@opencode/schema/event-manifest"
import type { OpenCodeEvent } from "@opencode/client"

import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { loadMessages } from "./session-api.ts"
import { getSessionMessagesLoadError, messagesLoaded, setActiveSession, setMessagesLoaded, setSessionMessagesLoadError, setSessions } from "./session-state.ts"
import { destroyOpenCodeData } from "./opencode-data.ts"
import { setSessionTranscriptVisible } from "./session-transcript-memory.ts"

const parentId = "ses_parent"
const childId = "ses_child"
const model = { providerID: "fixture", id: "fixture" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

// Validate the actual installed native wire schema, including durable envelopes.
function eventFactory() {
  let sequence = 0
  return (type: string, sessionId: string, payload: Record<string, unknown> = {}): OpenCodeEvent => {
    const definition = EventManifest.Latest.get(type as any) as any
    assert.ok(definition, type)
    const seq = ++sequence
    return Schema.decodeUnknownSync(definition)({
      id: `evt_${seq}`, type, created: seq, location: { directory: "/fixture" },
      ...(definition.durable ? { durable: { aggregateID: sessionId, seq, version: definition.durable.version } } : {}),
      data: { sessionID: sessionId, ...payload },
    }) as OpenCodeEvent
  }
}

function sessionEntry(instanceId: string, id: string, parentIdValue: string | null) {
  return {
    id, instanceId, parentId: parentIdValue, title: id, agent: "build",
    model: { providerId: "fixture", modelId: "fixture" }, status: "idle", retry: null,
    idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
    projectID: "prj_fixture", location: { directory: "/fixture" }, time: { created: 1, updated: 1 },
  } as any
}

async function delay(duration: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, duration))
}

describe("watched child session transcripts", () => {
  it("invalidates an unwatched child's loaded page and projects a visible child's stream instead", async () => {
    const instanceId = "child-watch"
    const make = eventFactory()
    const completedRow = {
      id: "msg_child_a", type: "assistant", agent: "build", model,
      time: { created: 1, completed: 5 }, content: [{ type: "text", id: "msg_child_a-text-0", text: "done" }],
    }
    const client: any = {
      session: { active: async () => ({}), get: async () => ({ id: childId, title: "Child" }),
        list: async () => ({ data: [], cursor: {} }), inbox: { list: async () => [] }, form: { list: async () => [] } },
      permission: { list: async () => [] },
      message: { list: async () => ({ data: [completedRow], cursor: {} }) },
    }
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([
      [parentId, sessionEntry(instanceId, parentId, null)],
      [childId, sessionEntry(instanceId, childId, parentId)],
    ])))
    setActiveSession(instanceId, parentId)
    const store = messageStoreBus.getOrCreate(instanceId)
    const dispatch = (type: string, sessionId: string, payload: Record<string, unknown> = {}) =>
      handleInstanceInvalidation(instanceId, make(type, sessionId, payload))
    const childLoaded = () => Boolean(messagesLoaded().get(instanceId)?.has(childId))

    try {
      // The task renderer's page load: the child is loaded but never active.
      assert.equal(await loadMessages(instanceId, childId), true)
      assert.ok(childLoaded(), "the child session page load committed")
      assert.equal(store.getMessageWindow(childId)?.kind, "latest")

      // An unwatched child transcript keeps the invalidation contract: streamed
      // events drop its loaded page so the next activation reads authoritatively.
      dispatch("session.step.started", childId, { assistantMessageID: "msg_child_live", agent: "build", model, started: 500 })
      await delay(20)
      assert.equal(childLoaded(), false, "an unwatched child's loaded page is invalidated by its stream")

      // A visible child transcript (its task renderer is mounted and active)
      // follows the live pages instead: no invalidation, projections land.
      assert.equal(await loadMessages(instanceId, childId), true)
      setSessionTranscriptVisible(instanceId, childId, true)
      const base = { assistantMessageID: "msg_child_live", ordinal: 0 }
      dispatch("session.step.started", childId, { ...base, agent: "build", model, started: 600 })
      dispatch("session.text.started", childId, base)
      dispatch("session.text.delta", childId, { ...base, delta: "x" })
      await delay(50)

      assert.ok(childLoaded(), "a visible child's loaded page survives its own stream")
      const streamed = store.getMessage("msg_child_live")
      assert.ok(streamed, "the streamed child message is resident in the display store")
      const text = Object.values(streamed?.parts ?? {})
        .map((entry) => (entry?.data as any)).find((part) => part?.type === "text") as any
      assert.equal(text?.text, "x", "the streamed delta projected into the visible child transcript")
    } finally {
      setSessionTranscriptVisible(instanceId, childId, false)
      destroyOpenCodeData(instanceId)
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      setMessagesLoaded((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("a latched load error must not survive the child transcript's activation read", async () => {
    const instanceId = "child-error-retry"
    const completedRow = {
      id: "msg_child_a", type: "assistant", agent: "build", model,
      time: { created: 1, completed: 5 }, content: [{ type: "text", id: "msg_child_a-text-0", text: "done" }],
    }
    const client: any = {
      session: { active: async () => ({}), get: async () => ({ id: childId, title: "Child" }),
        list: async () => ({ data: [], cursor: {} }), inbox: { list: async () => [] }, form: { list: async () => [] } },
      permission: { list: async () => [] },
      message: { list: async () => ({ data: [completedRow], cursor: {} }) },
    }
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([
      [parentId, sessionEntry(instanceId, parentId, null)],
      [childId, sessionEntry(instanceId, childId, parentId)],
    ])))
    setActiveSession(instanceId, parentId)

    try {
      // A load that failed mid-stream latched an error: automatic loads are
      // refused so nothing retries in a loop.
      setSessionMessagesLoadError(instanceId, childId, "mid-stream revision conflict")
      assert.equal(await loadMessages(instanceId, childId), false, "a non-forced read stays blocked by the latched error")

      // The task renderer's activation read is forced: it reads past the
      // stale error, and its successful commit clears the error for good.
      assert.equal(await loadMessages(instanceId, childId, { force: true }), true)
      assert.equal(getSessionMessagesLoadError(instanceId, childId), undefined)
      assert.ok(messagesLoaded().get(instanceId)?.has(childId), "the forced activation read committed")
    } finally {
      destroyOpenCodeData(instanceId)
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      setMessagesLoaded((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      setSessionMessagesLoadError(instanceId, childId, null)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })
})
