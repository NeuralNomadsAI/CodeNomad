import assert from "node:assert/strict"
import { after, afterEach, before, describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { executeCustomCommand, runShellCommand, sendMessage, updateSessionAgent, updateSessionModel } from "./session-actions.ts"
import { setConversationModeEnabled } from "./conversation-speech.ts"
import { getModelThinkingSelection, setModelThinkingSelection } from "./preferences"
import { sessions, setProviders, setSessions } from "./session-state.ts"

const instanceId = "session-actions"
const sessionId = "session"
const storageMethods = {
  fetchConfigOwner: serverApi.fetchConfigOwner,
  fetchStateOwner: serverApi.fetchStateOwner,
  patchStateOwner: serverApi.patchStateOwner,
}
let testUiState: Record<string, any> = {}

before(() => {
  serverApi.fetchConfigOwner = async <T extends Record<string, any> = Record<string, any>>() => ({} as T)
  serverApi.fetchStateOwner = async <T extends Record<string, any> = Record<string, any>>() => testUiState as T
  serverApi.patchStateOwner = async <T extends Record<string, any> = Record<string, any>>(_owner: string, value: unknown) => {
    const patch = value as Record<string, any>
    testUiState = {
      ...testUiState,
      ...patch,
      ...(patch.models ? { models: { ...testUiState.models, ...patch.models } } : {}),
    }
    return testUiState as T
  }
})

after(() => {
  Object.assign(serverApi, storageMethods)
})

function seed(client: any): void {
  const session = {
    id: sessionId,
    instanceId,
    parentId: null,
    title: sessionId,
    agent: "build",
    model: { providerId: "provider", modelId: "old" },
    status: "idle",
    location: { directory: "/work" },
    time: { created: 1, updated: 1 },
  } as Session

  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(new Map([[instanceId, new Map([[sessionId, session]])]]))
  setProviders(new Map([[instanceId, [{ id: "provider", name: "Provider", models: [
    { id: "old", name: "Old", providerId: "provider", variantKeys: ["high"] },
    { id: "new", name: "New", providerId: "provider", variantKeys: ["high"] },
  ] }]]]))
}

async function selectVariant(modelId: string, variant: string): Promise<void> {
  const model = { providerId: "provider", modelId }
  setModelThinkingSelection(model, variant)
  while (getModelThinkingSelection(model) !== variant) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

afterEach(() => {
  setSessions(new Map())
  setProviders(new Map())
  removeInstance(instanceId, { authoritative: false })
  sdkManager.destroyClientsForInstance(instanceId)
  setConversationModeEnabled(instanceId, false)
  setModelThinkingSelection({ providerId: "provider", modelId: "old" }, undefined)
  setModelThinkingSelection({ providerId: "provider", modelId: "new" }, undefined)
})

describe("voice instruction sync", () => {
  it("syncs the enabled instruction before a slash command", async () => {
    const calls: string[] = []
    seed({ session: {
      instructions: { entry: {
        put: async () => { calls.push("put") },
        remove: async () => { calls.push("remove") },
      } },
      command: async () => { calls.push("command") },
    } })
    setConversationModeEnabled(instanceId, true)

    await executeCustomCommand(instanceId, sessionId, "review", "")

    assert.deepEqual(calls, ["put", "command"])
  })

  it("removes a stale instruction before a shell command", async () => {
    const calls: string[] = []
    seed({ session: {
      instructions: { entry: {
        put: async () => { calls.push("put") },
        remove: async () => { calls.push("remove") },
      } },
      shell: async () => { calls.push("shell") },
    } })

    await runShellCommand(instanceId, sessionId, "pwd")

    assert.deepEqual(calls, ["remove", "shell"])
  })

  it("serializes concurrent syncs so the latest mode wins remotely", async () => {
    const calls: string[] = []
    let releasePut!: () => void
    const putGate = new Promise<void>((resolve) => { releasePut = resolve })
    seed({ session: {
      instructions: { entry: {
        put: async () => { calls.push("put:start"); await putGate; calls.push("put:end") },
        remove: async () => { calls.push("remove") },
      } },
      command: async () => { calls.push("command") },
      shell: async () => { calls.push("shell") },
    } })
    setConversationModeEnabled(instanceId, true)
    const first = executeCustomCommand(instanceId, sessionId, "review", "")
    await new Promise<void>((resolve) => setImmediate(resolve))
    setConversationModeEnabled(instanceId, false)
    releasePut()
    await first

    assert.deepEqual(calls, ["put:start", "put:end", "remove", "command"])
    assert.equal(calls.filter((call) => call === "remove").length, 1)
  })
})

describe("native session selection persistence", () => {
  it("switches the native agent", async () => {
    const inputs: unknown[] = []
    seed({ session: {
      switchAgent: async (value: unknown) => { inputs.push(value) },
      switchModel: async (value: unknown) => { inputs.push(value) },
    } })

    await updateSessionAgent(instanceId, sessionId, "plan")

    assert.deepEqual(inputs, [
      { sessionID: sessionId, agent: "plan" },
      { sessionID: sessionId, model: { providerID: "provider", id: "old" } },
    ])
    assert.equal(sessions().get(instanceId)?.get(sessionId)?.agent, "plan")
  })

  it("switches the native model with ModelRef field names", async () => {
    let input: unknown
    seed({ session: { switchModel: async (value: unknown) => { input = value } } })

    await updateSessionModel(instanceId, sessionId, { providerId: "provider", modelId: "new" })

    assert.deepEqual(input, {
      sessionID: sessionId,
      model: { providerID: "provider", id: "new" },
    })
    assert.deepEqual(sessions().get(instanceId)?.get(sessionId)?.model, { providerId: "provider", modelId: "new" })
  })

  it("persists the selected variant for model and agent-driven model switches", async () => {
    const inputs: unknown[] = []
    seed({ session: {
      switchAgent: async () => {},
      switchModel: async (value: unknown) => { inputs.push(value) },
    } })
    await selectVariant("new", "high")
    await selectVariant("old", "high")

    await updateSessionModel(instanceId, sessionId, { providerId: "provider", modelId: "new" })
    await updateSessionAgent(instanceId, sessionId, "plan")

    assert.deepEqual(inputs, [
      { sessionID: sessionId, model: { providerID: "provider", id: "new", variant: "high" } },
      { sessionID: sessionId, model: { providerID: "provider", id: "old", variant: "high" } },
    ])
    assert.deepEqual(sessions().get(instanceId)?.get(sessionId)?.model, { providerId: "provider", modelId: "old" })
  })

  it("rolls back local selections when native switching fails", async () => {
    const error = new Error("switch failed")
    seed({ session: {
      switchAgent: async () => { throw error },
      switchModel: async () => { throw error },
    } })

    await assert.rejects(updateSessionAgent(instanceId, sessionId, "plan"), error)
    assert.equal(sessions().get(instanceId)?.get(sessionId)?.agent, "build")

    await assert.rejects(updateSessionModel(instanceId, sessionId, { providerId: "provider", modelId: "new" }), error)
    assert.deepEqual(sessions().get(instanceId)?.get(sessionId)?.model, { providerId: "provider", modelId: "old" })
  })
})

describe("native prompt serialization", () => {
  it("sends agent attachments with mention offsets and the selected model variant", async () => {
    const calls: Array<{ type: string; input: any }> = []
    seed({ session: {
      instructions: { entry: { put: async () => {}, remove: async () => {} } },
      switchModel: async (input: unknown) => { calls.push({ type: "model", input }) },
      prompt: async (input: unknown) => { calls.push({ type: "prompt", input }) },
    } })
    await selectVariant("old", "high")
    setProviders(new Map([[instanceId, [{ id: "provider", name: "Provider", models: [
      { id: "old", name: "Old", providerId: "provider", variantKeys: ["high"] },
    ] }]]]))

    await sendMessage(instanceId, sessionId, "Ask @reviewer now", [{
      id: "agent-attachment",
      type: "agent",
      display: "@reviewer",
      url: "",
      filename: "reviewer",
      mediaType: "text/plain",
      source: { type: "agent", name: "reviewer" },
    }])

    assert.deepEqual(calls[0], {
      type: "model",
      input: { sessionID: sessionId, model: { providerID: "provider", id: "old", variant: "high" } },
    })
    assert.deepEqual(calls[1]?.input.agents, [{
      name: "reviewer",
      mention: { start: 4, end: 13, text: "@reviewer" },
    }])
  })
})
