import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, removeInstance } from "./instances.ts"
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
