import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { executeCustomCommand, runShellCommand, updateSessionAgent, updateSessionModel } from "./session-actions.ts"
import { setConversationModeEnabled } from "./conversation-speech.ts"
import { sessions, setProviders, setSessions } from "./session-state.ts"

const instanceId = "session-actions"
const sessionId = "session"

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
    { id: "old", name: "Old", providerId: "provider" },
    { id: "new", name: "New", providerId: "provider" },
  ] }]]]))
}

afterEach(() => {
  setSessions(new Map())
  setProviders(new Map())
  removeInstance(instanceId, { authoritative: false })
  sdkManager.destroyClientsForInstance(instanceId)
  setConversationModeEnabled(instanceId, false)
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
})

describe("native session selection persistence", () => {
  it("switches the native agent", async () => {
    let input: unknown
    seed({ session: { switchAgent: async (value: unknown) => { input = value } } })

    await updateSessionAgent(instanceId, sessionId, "plan")

    assert.deepEqual(input, { sessionID: sessionId, agent: "plan" })
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
