import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, removeInstance, updateInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { executeCustomCommand, runShellCommand, sendMessage } from "./session-actions.ts"
import { setSessions } from "./session-state.ts"

function setup(instanceId: string, sessionId: string) {
  const client = { session: {} } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 1, proxyPath: "", status: "ready", client })
  setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, {
    id: sessionId,
    instanceId,
    parentId: null,
    title: sessionId,
    agent: "build",
    model: { providerId: "", modelId: "" },
    status: "idle",
    retry: null,
    idleSince: null,
    version: "1",
  } as any]])))
  return {
    client,
    cleanup() {
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    },
  }
}

describe("dispatched command delivery classification", () => {
  it("commits the fetched message when ambiguous delivery verification finds it", async () => {
    const instanceId = "prompt-delivery-verified", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    let messageId = ""
    ;(client.session as any).promptAsync = async (input: any) => {
      messageId = input.messageID
      throw new TypeError("Failed to fetch")
    }
    ;(client.session as any).messages = async () => ({ data: [{
      info: { id: messageId, sessionID: sessionId, role: "user", time: { created: 1 } },
      parts: [{ id: "server-part", sessionID: sessionId, messageID: messageId, type: "text", text: "server prompt" }],
    }] })

    try {
      await sendMessage(instanceId, sessionId, "optimistic prompt")
      const message = messageStoreBus.getOrCreate(instanceId).getMessage(messageId)
      assert.equal(message?.status, "complete")
      assert.equal(message?.isEphemeral, false)
      assert.deepEqual(message?.partIds, ["server-part"])
      assert.equal((message?.parts["server-part"]?.data as any)?.text, "server prompt")
    } finally {
      cleanup()
    }
  })

  it("does not seed ambiguous verification from a replaced runtime", async () => {
    const instanceId = "prompt-delivery-replaced-runtime", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    let messageId = ""
    let resolveVerification!: (value: any) => void
    ;(client.session as any).promptAsync = async (input: any) => {
      messageId = input.messageID
      throw new TypeError("Failed to fetch")
    }
    ;(client.session as any).messages = () => new Promise((resolve) => { resolveVerification = resolve })

    try {
      const request = sendMessage(instanceId, sessionId, "optimistic prompt")
      while (!resolveVerification) await new Promise<void>((resolve) => setImmediate(resolve))
      updateInstance(instanceId, { client: { session: {} } as any })
      resolveVerification({ data: [{
        info: { id: messageId, sessionID: sessionId, role: "user", time: { created: 1 } },
        parts: [{ id: "stale-part", type: "text", text: "stale snapshot" }],
      }] })
      await request

      const message = messageStoreBus.getOrCreate(instanceId).getMessage(messageId)
      assert.equal(message?.isEphemeral, true)
      assert.equal(message?.parts["stale-part"], undefined)
    } finally {
      cleanup()
    }
  })

  it("keeps a pre-response transport failure ambiguous after empty verification", async () => {
    const instanceId = "prompt-delivery-empty", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    let dispatchCalls = 0
    let verificationCalls = 0
    ;(client.session as any).promptAsync = async () => {
      dispatchCalls += 1
      throw new TypeError("Failed to fetch")
    }
    ;(client.session as any).messages = async () => {
      verificationCalls += 1
      return { data: [] }
    }

    try {
      const error = await sendMessage(instanceId, sessionId, "keep this draft").catch((failure) => failure)
      assert.equal(error?.suppressPromptRecovery, true)
      assert.equal(dispatchCalls, 1)
      assert.equal(verificationCalls, 3)
    } finally {
      cleanup()
    }
  })

  it("keeps a transport failure ambiguous after stale successful verification", async () => {
    const instanceId = "prompt-delivery-unknown", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    let verificationCalls = 0
    ;(client.session as any).promptAsync = async () => { throw new TypeError("terminated") }
    ;(client.session as any).messages = async () => {
      verificationCalls += 1
      if (verificationCalls === 1) return { data: [] }
      throw new TypeError("verification disconnected")
    }

    try {
      const error = await sendMessage(instanceId, sessionId, "run it").catch((failure) => failure)
      assert.equal(error?.suppressPromptRecovery, true)
      assert.equal(verificationCalls, 3)
    } finally {
      cleanup()
    }
  })

  it("keeps an explicit prompt rejection replayable after verification", async () => {
    const instanceId = "prompt-delivery-rejected", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    ;(client.session as any).promptAsync = async () => ({
      error: { message: "Bad prompt" },
      response: { status: 400 },
    })
    ;(client.session as any).messages = async () => ({ data: [] })

    try {
      const error = await sendMessage(instanceId, sessionId, "bad").catch((failure) => failure)
      assert.notEqual(error?.suppressPromptRecovery, true)
    } finally {
      cleanup()
    }
  })

  it("keeps a rate-limited prompt replayable", async () => {
    const instanceId = "prompt-delivery-rate-limited", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    ;(client.session as any).promptAsync = async () => ({
      error: { message: "Rate limited" },
      response: { status: 429 },
    })
    ;(client.session as any).messages = async () => ({ data: [] })

    try {
      const error = await sendMessage(instanceId, sessionId, "retry me").catch((failure) => failure)
      assert.notEqual(error?.suppressPromptRecovery, true)
    } finally {
      cleanup()
    }
  })

  it("suppresses replay for unknown command and shell failures", async () => {
    const instanceId = "delivery-unknown", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    ;(client.session as any).command = async () => { throw new SyntaxError("Unexpected end of JSON input") }
    ;(client.session as any).shell = async () => { throw new TypeError("terminated") }

    try {
      const commandError = await executeCustomCommand(instanceId, sessionId, "test", "").catch((error) => error)
      const shellError = await runShellCommand(instanceId, sessionId, "echo test").catch((error) => error)
      assert.equal(commandError?.suppressPromptRecovery, true)
      assert.equal(shellError?.suppressPromptRecovery, true)
    } finally {
      cleanup()
    }
  })

  it("keeps a definitive client rejection replayable", async () => {
    const instanceId = "delivery-rejected", sessionId = "session"
    const { client, cleanup } = setup(instanceId, sessionId)
    ;(client.session as any).command = async () => ({
      error: { message: "Bad command" },
      response: { status: 400 },
    })

    try {
      const error = await executeCustomCommand(instanceId, sessionId, "bad", "").catch((failure) => failure)
      assert.notEqual(error?.suppressPromptRecovery, true)
    } finally {
      cleanup()
    }
  })
})
