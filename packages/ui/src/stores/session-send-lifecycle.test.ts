import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { setConversationModeEnabled } from "./conversation-speech.ts"
import { sendMessage } from "./session-actions.ts"
import { handleNativeSessionEvent, handleSessionError } from "./session-events.ts"
import { clearInstanceDeletedSessionAuthority, setSessions } from "./session-state.ts"
import { partHasRenderableText } from "../types/message.ts"

function session(instanceId: string, id: string): Session {
  return {
    id,
    instanceId,
    parentId: null,
    title: id,
    agent: "build",
    model: { providerId: "provider", modelId: "model" },
    status: "idle",
    retry: null,
    idleSince: null,
    generationRecovery: null,
    runtimeStatusKnown: true,
    version: "1",
    projectID: "project",
    location: { directory: "/work" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
}

function setup(
  instanceId: string,
  sessionId: string,
  prompt: (input: any) => Promise<any>,
  entry = { put: async (_input: any) => undefined, remove: async (_input: any) => undefined },
  list = async () => ({ data: [] }),
) {
  const client = {
    session: {
      prompt,
      switchModel: async () => undefined,
      instructions: { entry },
    },
    message: { list },
  } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, session(instanceId, sessionId)]])))

  return () => {
    messageStoreBus.unregisterInstance(instanceId)
    setSessions((prev) => {
      const next = new Map(prev)
      next.delete(instanceId)
      return next
    })
    clearInstanceDeletedSessionAuthority(instanceId)
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
    setConversationModeEnabled(instanceId, false)
  }
}

describe("optimistic send lifecycle", () => {
  it("renders the optimistic prompt before any native request resolves", async () => {
    const instanceId = "send-immediate"
    const sessionId = "session"
    let releaseInstruction!: () => void
    const instruction = new Promise<undefined>((resolve) => { releaseInstruction = () => resolve(undefined) })
    const cleanup = setup(
      instanceId,
      sessionId,
      async () => undefined,
      { put: async () => instruction, remove: async () => instruction },
    )

    try {
      const sending = sendMessage(instanceId, sessionId, "hello")
      const store = messageStoreBus.getOrCreate(instanceId)
      const [messageId] = store.getSessionMessageIds(sessionId)
      const record = messageId ? store.getMessage(messageId) : undefined
      const textPart = record?.partIds.map((id) => record.parts[id]?.data).find((part) => part?.type === "text")

      assert.equal(record?.status, "sending")
      assert.equal(textPart?.text, "hello")
      assert.equal(textPart ? partHasRenderableText(textPart) : false, true)

      releaseInstruction()
      await sending
    } finally {
      cleanup()
    }
  })

  it("writes the native session voice instruction before prompting", async () => {
    const instanceId = "send-voice-mode"
    const sessionId = "session"
    const calls: string[] = []
    const cleanup = setup(
      instanceId,
      sessionId,
      async () => { calls.push("prompt") },
      {
        put: async (input) => { calls.push(`put:${input.key}`) },
        remove: async () => { calls.push("remove") },
      },
    )

    try {
      setConversationModeEnabled(instanceId, true)
      await sendMessage(instanceId, sessionId, "hello")
      assert.deepEqual(calls, ["put:codenomad.voice-mode", "prompt"])
    } finally {
      cleanup()
    }
  })

  it("marks the optimistic message sent when prompt accepts it", async () => {
    const instanceId = "send-accepted"
    const sessionId = "session"
    let request: any
    const cleanup = setup(instanceId, sessionId, async (input) => {
      request = input
      return { id: "pending", sessionID: sessionId }
    })

    try {
      await sendMessage(instanceId, sessionId, "hello")
      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal(typeof request.id, "string")
      assert.equal(store.getMessage(request.id)?.status, "sent")
      assert.equal(store.getMessage(request.id)?.isEphemeral, false)
    } finally {
      cleanup()
    }
  })

  it("marks a rejected prompt failed so authoritative hydration can remove it", async () => {
    const instanceId = "send-rejected"
    const sessionId = "session"
    let request: any
    const cleanup = setup(instanceId, sessionId, async (input) => {
      request = input
      throw new Error("rejected")
    })

    try {
      await assert.rejects(() => sendMessage(instanceId, sessionId, "hello"))
      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal(store.getMessage(request.id)?.status, "error")

      store.reconcileEmptyAuthoritativeSnapshot(sessionId)
      assert.equal(store.getMessage(request.id), undefined)
      assert.deepEqual(store.getSessionMessageIds(sessionId), [])
    } finally {
      cleanup()
    }
  })

  it("retires an accepted send after an asynchronous session error", async () => {
    const instanceId = "send-session-error"
    const sessionId = "session"
    let request: any
    const cleanup = setup(instanceId, sessionId, async (input) => {
      request = input
      return { id: "pending", sessionID: sessionId }
    })

    try {
      await sendMessage(instanceId, sessionId, "hello")
      const store = messageStoreBus.getOrCreate(instanceId)
      handleSessionError(instanceId, {
        id: "failure",
        created: 1,
        type: "session.execution.failed",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId, error: { type: "generation", message: "generation failed" } },
      } as any)
      assert.equal(store.getMessage(request.id)?.status, "error")

      store.reconcileEmptyAuthoritativeSnapshot(sessionId)
      assert.equal(store.getMessage(request.id), undefined)
    } finally {
      cleanup()
    }
  })

  it("refreshes an accepted send on native success without marking it failed", async () => {
    const instanceId = "send-session-success"
    const sessionId = "session"
    let request: any
    let refreshCalls = 0
    const cleanup = setup(
      instanceId,
      sessionId,
      async (input) => { request = input; return { id: "pending", sessionID: sessionId } },
      undefined,
      async () => { refreshCalls += 1; return { data: [] } },
    )

    try {
      await sendMessage(instanceId, sessionId, "hello")
      const store = messageStoreBus.getOrCreate(instanceId)
      handleNativeSessionEvent(instanceId, {
        id: "success",
        created: 1,
        type: "session.execution.succeeded",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId },
      } as any)

      assert.equal(store.getMessage(request.id)?.status, "sent")
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(refreshCalls, 1)
      assert.notEqual(store.getMessage(request.id)?.status, "error")
    } finally {
      cleanup()
    }
  })

  it("marks accepted sends failed when native execution is interrupted", async () => {
    const instanceId = "send-session-interrupted"
    const sessionId = "session"
    let request: any
    const cleanup = setup(instanceId, sessionId, async (input) => {
      request = input
      return { id: "pending", sessionID: sessionId }
    })

    try {
      await sendMessage(instanceId, sessionId, "hello")
      const store = messageStoreBus.getOrCreate(instanceId)
      handleNativeSessionEvent(instanceId, {
        id: "interrupted",
        created: 1,
        type: "session.execution.interrupted",
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: { sessionID: sessionId, reason: "cancelled" },
      } as any)

      assert.equal(store.getMessage(request.id)?.status, "error")
    } finally {
      cleanup()
    }
  })
})
