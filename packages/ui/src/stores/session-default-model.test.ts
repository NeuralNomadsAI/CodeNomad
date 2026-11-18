import assert from "node:assert/strict"
import test from "node:test"
import { createComputed, createRoot } from "solid-js"
import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import { storage } from "../lib/storage"
import { addInstance, removeInstance } from "./instances"
import { clearInstanceConfig } from "./instance-config"
import { getDefaultModel } from "./session-models"
import { createSession } from "./session-api"
import { sendMessage } from "./session-actions"
import { addRecentModelPreference, uiState } from "./preferences"
import { messageStoreBus } from "./message-v2/bus"
import { setAgents, setProviders } from "./session-state"

test("a cold model catalog preserves explicit choices through creation and send (#1444)", async t => {
  const instanceId = "cold-default-model"
  const selected = { providerId: "opencode", modelId: "chosen-go-model" }
  const originalRead = serverApi.fetchConfigOwner
  const originalLoad = storage.loadInstanceData
  const originalStateRead = serverApi.fetchStateOwner
  const originalStateWrite = serverApi.patchStateOwner
  serverApi.fetchConfigOwner = async () => ({}) as never
  serverApi.fetchStateOwner = async () => ({}) as never
  serverApi.patchStateOwner = async (_owner, patch) => patch as never
  storage.loadInstanceData = async () => ({ messageHistory: [], agentModelSelections: { build: selected } })
  let defaultReads = 0
  const created: any[] = [], switched: any[] = [], prompts: any[] = []
  const client = { session: {
    create: async (input: any) => {
      created.push(input)
      return { ...input, id: "new-session", title: "New", parentID: null, time: { created: 1, updated: 1 } }
    },
    instructions: { entry: { put: async () => {}, remove: async () => {} } },
    switchAgent: async () => {},
    switchModel: async (input: any) => { switched.push(input.model) },
    prompt: async (input: any) => { prompts.push(input); return { id: input.id } },
  }, model: { default: async () => {
    defaultReads++
    return { data: { providerID: "openrouter", id: "unselected-paid-model" } }
  } } } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setAgents(previous => new Map(previous).set(instanceId, [{ id: "build", name: "Build", description: "", mode: "primary" }]))
  setProviders(previous => { const next = new Map(previous); next.delete(instanceId); return next })
  try {
    await t.test("saved agent model survives a cold catalog and reaches the native prompt", async () => {
      assert.deepEqual(await getDefaultModel(instanceId, "build"), selected)
      const session = await createSession(instanceId, "build")
      assert.deepEqual(created[0].model, { providerID: selected.providerId, id: selected.modelId })
      await sendMessage(instanceId, session.id, "test prompt")
      assert.deepEqual(switched.at(-1), { providerID: selected.providerId, id: selected.modelId })
      assert.equal(prompts.length, 1)
      assert.equal(defaultReads, 0)
    })
    await t.test("configured agent models also survive a cold catalog", async () => {
      setAgents(previous => new Map(previous).set(instanceId, [{ id: "configured", name: "Configured", description: "", mode: "primary", model: selected }]))
      assert.deepEqual(await getDefaultModel(instanceId, "configured"), selected)
      assert.equal(defaultReads, 0)
    })
    await t.test("a recent user choice survives a cold catalog without an agent", async () => {
      const written = new Promise<void>(resolve => createRoot(dispose => createComputed(() => {
        if (uiState().models.recents[0]?.modelId !== selected.modelId) return
        dispose()
        resolve()
      })))
      addRecentModelPreference(selected)
      await written
      assert.deepEqual(await getDefaultModel(instanceId), selected)
      assert.equal(defaultReads, 0)
    })
    await t.test("a loaded catalog still validates unavailable choices and keeps its default", async () => {
      const fallback = { providerId: "fixture", modelId: "catalog-default" }
      setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture", defaultModelId: fallback.modelId,
        models: [{ id: fallback.modelId, name: "Default", providerId: fallback.providerId }] }]))
      assert.deepEqual(await getDefaultModel(instanceId, "build"), fallback)
      assert.equal(defaultReads, 0)
    })
  } finally {
    serverApi.fetchConfigOwner = originalRead
    storage.loadInstanceData = originalLoad
    serverApi.fetchStateOwner = originalStateRead
    serverApi.patchStateOwner = originalStateWrite
    messageStoreBus.unregisterInstance(instanceId)
    clearInstanceConfig(instanceId)
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
})
