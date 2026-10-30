import assert from "node:assert/strict"
import { after, afterEach, before, test } from "node:test"
import { serverApi } from "../lib/api-client.ts"
import { knownModelName, rememberModelNames } from "./model-picker.ts"
import { destroyOpenCodeData } from "./opencode-data.ts"
import { setProviders } from "./session-state.ts"

const instanceId = "model-picker", model = { providerID: "claude-code", id: "opus" }
const storage = { fetchConfigOwner: serverApi.fetchConfigOwner, fetchStateOwner: serverApi.fetchStateOwner }
before(() => {
  serverApi.fetchConfigOwner = async () => ({}) as any
  serverApi.fetchStateOwner = async () => ({}) as any
})
after(() => Object.assign(serverApi, storage))
afterEach(() => setProviders(new Map()))

const conversation = (name: string) => new Map([[instanceId, [{ id: "claude-code", name: "Claude Code", models: [{ id: "opus", name, providerId: "claude-code" }] }]]])
const missions = (name: string) => [{ id: "opus", name, providerId: "claude-code", providerName: "Claude Code" }]

test("the newer of the conversation catalog and the Missions read names a model", () => {
  setProviders(conversation("Opus 5"))
  rememberModelNames(instanceId, "/project", missions("Opus 5.5"))
  assert.equal(knownModelName(instanceId, "/project", model), "Opus 5.5", "the Missions read came after the conversation catalog")
  setProviders(conversation("Opus 5.5 Fast"))
  assert.equal(knownModelName(instanceId, "/project", model), "Opus 5.5 Fast", "a later conversation catalog wins over the remembered name")
  rememberModelNames(instanceId, "/project", missions("Opus 6"))
  assert.equal(knownModelName(instanceId, "/project", model), "Opus 6")
})

test("remembered names serve only their Location and native generation", () => {
  rememberModelNames(instanceId, "/project", missions("Opus 5.5"))
  assert.equal(knownModelName(instanceId, "/project", model), "Opus 5.5", "without a conversation catalog (Preferences window)")
  assert.equal(knownModelName(instanceId, "/other", model), undefined)
  assert.equal(knownModelName(instanceId, "/project", { providerID: "claude-code", id: "unknown" }), undefined)
  setProviders(conversation("Opus 5.5 Fast"))
  assert.equal(knownModelName(instanceId, "/other", model), "Opus 5.5 Fast", "another Location still uses the conversation catalog")
  setProviders(new Map())
  destroyOpenCodeData(instanceId)
  assert.equal(knownModelName(instanceId, "/project", model), undefined, "a reconnect retires the earlier read")
})
