import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
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
    time: { created: 1, updated: 1 },
  }
}

function setup(instanceId: string, sessionId: string, promptAsync: (input: any) => Promise<any>) {
  const client = { session: { promptAsync } } as any
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
  }
}

describe("optimistic send lifecycle", () => {
  it("marks the optimistic message sent when promptAsync accepts it", async () => {
    const instanceId = "send-accepted"
    const sessionId = "session"
    let request: any
    const cleanup = setup(instanceId, sessionId, async (input) => {
      request = input
      return { data: undefined }
    })

    try {
      await sendMessage(instanceId, sessionId, "hello")
      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal(typeof request.messageID, "string")
      assert.equal(store.getMessage(request.messageID)?.status, "sent")
      assert.equal(store.getMessage(request.messageID)?.isEphemeral, false)
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
      return { error: { message: "rejected" } }
    })

    try {
      await assert.rejects(() => sendMessage(instanceId, sessionId, "hello"))
      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal(store.getMessage(request.messageID)?.status, "error")

      store.reconcileEmptyAuthoritativeSnapshot(sessionId)
      assert.equal(store.getMessage(request.messageID), undefined)
      assert.deepEqual(store.getSessionMessageIds(sessionId), [])
    } finally {
      cleanup()
    }
  })

  it("keeps same-id SSE confirmation authoritative when the request later rejects", async () => {
    const instanceId = "send-sse-first"
    const sessionId = "session"
    let request: any
    let resolvePrompt!: (value: any) => void
    const prompt = new Promise<any>((resolve) => {
      resolvePrompt = resolve
    })
    const cleanup = setup(instanceId, sessionId, async (input) => {
      request = input
      return prompt
    })

    try {
      const sending = sendMessage(instanceId, sessionId, "hello")
      await tick()
      assert.equal(typeof request.messageID, "string")

      handleMessageUpdate(instanceId, {
        type: "message.updated",
        properties: {
          info: { id: request.messageID, sessionID: sessionId, role: "user", time: { created: 1 } },
        },
      } as any)
      handleMessageUpdate(instanceId, {
        type: "message.part.updated",
        properties: {
          part: { id: "server-part", sessionID: sessionId, messageID: request.messageID, type: "text", text: "hello" },
        },
      } as any)
      resolvePrompt({ error: { message: "response lost" } })
      await assert.rejects(sending)

      const record = messageStoreBus.getOrCreate(instanceId).getMessage(request.messageID)
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
      return { error: { message: "response lost" } }
    })

    try {
      await assert.rejects(() => sendMessage(instanceId, sessionId, "hello"))
      handleMessageUpdate(instanceId, {
        type: "message.updated",
        properties: { info: { id: request.messageID, sessionID: sessionId, role: "user", time: { created: 1 } } },
      } as any)
      handleMessageUpdate(instanceId, {
        type: "message.part.updated",
        properties: {
          part: { id: "server-part", sessionID: sessionId, messageID: request.messageID, type: "text", text: "hello" },
        },
      } as any)

      const record = messageStoreBus.getOrCreate(instanceId).getMessage(request.messageID)
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
      return { data: undefined }
    })

    try {
      await sendMessage(instanceId, sessionId, "hello")
      const store = messageStoreBus.getOrCreate(instanceId)
      handleSessionError(instanceId, {
        type: "session.error",
        properties: { sessionID: sessionId, error: { message: "generation failed" } },
      } as any)
      assert.equal(store.getMessage(request.messageID)?.status, "error")

      store.reconcileEmptyAuthoritativeSnapshot(sessionId)
      assert.equal(store.getMessage(request.messageID), undefined)
    } finally {
      cleanup()
    }
  })
})
