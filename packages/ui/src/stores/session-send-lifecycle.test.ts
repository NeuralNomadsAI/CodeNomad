import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { setConversationModeEnabled } from "./conversation-speech.ts"
import { sendMessage } from "./session-actions.ts"
import { handleMessageUpdate, handleSessionError } from "./session-events.ts"
import { clearInstanceDeletedSessionAuthority, setSessions } from "./session-state.ts"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

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
) {
  const client = {
    session: {
      prompt,
      instructions: { entry },
    },
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

  it("keeps same-id SSE confirmation authoritative when the request later rejects", async () => {
    const instanceId = "send-sse-first"
    const sessionId = "session"
    let request: any
    let rejectPrompt!: (error: Error) => void
    const prompt = new Promise<any>((_resolve, reject) => {
      rejectPrompt = reject
    })
    const cleanup = setup(instanceId, sessionId, async (input) => {
      request = input
      return prompt
    })

    try {
      const sending = sendMessage(instanceId, sessionId, "hello")
      await tick()
      assert.equal(typeof request.id, "string")

      handleMessageUpdate(instanceId, {
        type: "message.updated",
        properties: {
          info: { id: request.id, sessionID: sessionId, role: "user", time: { created: 1 } },
        },
      } as any)
      handleMessageUpdate(instanceId, {
        type: "message.part.updated",
        properties: {
          part: { id: "server-part", sessionID: sessionId, messageID: request.id, type: "text", text: "hello" },
        },
      } as any)
      rejectPrompt(new Error("response lost"))
      await assert.rejects(sending)

      const record = messageStoreBus.getOrCreate(instanceId).getMessage(request.id)
      assert.equal(record?.isEphemeral, false)
      assert.equal(record?.status, "complete")
      assert.deepEqual(record?.partIds, ["server-part"])
      assert.equal((record?.parts["server-part"]?.data as any)?.text, "hello")
    } finally {
      cleanup()
    }
  })

  it("reconciles exact optimistic parts when rejection arrives before same-id SSE", async () => {
    const instanceId = "send-rejected-before-sse"
    const sessionId = "session"
    let request: any
    const cleanup = setup(instanceId, sessionId, async (input) => {
      request = input
      throw new Error("response lost")
    })

    try {
      await assert.rejects(() => sendMessage(instanceId, sessionId, "hello"))
      handleMessageUpdate(instanceId, {
        type: "message.updated",
        properties: { info: { id: request.id, sessionID: sessionId, role: "user", time: { created: 1 } } },
      } as any)
      handleMessageUpdate(instanceId, {
        type: "message.part.updated",
        properties: {
          part: { id: "server-part", sessionID: sessionId, messageID: request.id, type: "text", text: "hello" },
        },
      } as any)

      const record = messageStoreBus.getOrCreate(instanceId).getMessage(request.id)
      assert.deepEqual(record?.partIds, ["server-part"])
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
})
