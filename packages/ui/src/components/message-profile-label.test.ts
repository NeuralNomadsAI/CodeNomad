import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { setAgents, setProviders } from "../stores/session-state.ts"
import type { MessageInfo } from "../types/message"
import { messageProfileLabel } from "./message-profile-label.ts"

const instanceId = "instance"
const assistant = (fields: Partial<MessageInfo>) => ({ role: "assistant", ...fields }) as MessageInfo

afterEach(() => {
  setAgents(new Map())
  setProviders(new Map())
})

test("names the agent and model as the composer footer does and keeps the identifiers for the tooltip", () => {
  setAgents(new Map([[instanceId, [{ id: "build", name: "Build", description: "", mode: "primary" }]]]))
  setProviders(new Map([[instanceId, [{ id: "claude-code", name: "Claude Code", models: [
    { id: "claude-opus-5-5[1m]:fast", name: "Opus 5.5 Fast", providerId: "claude-code" },
  ] }]]]))

  const label = messageProfileLabel(instanceId, assistant({
    mode: "build", providerID: "claude-code", modelID: "claude-opus-5-5[1m]:fast", variant: " xhigh ",
  }))

  assert.deepEqual(label, {
    text: "Build • Opus 5.5 Fast • xhigh",
    exact: "build • claude-code/claude-opus-5-5[1m]:fast • xhigh",
  })
})

test("keeps identifiers for an agent or model missing from the catalogs", () => {
  setProviders(new Map([[instanceId, [{ id: "claude-code", name: "Claude Code", models: [] }]]]))

  const label = messageProfileLabel(instanceId, assistant({ mode: "review", providerID: "claude-code", modelID: "gone" }))

  assert.deepEqual(label, { text: "review • claude-code/gone", exact: "review • claude-code/gone" })
})

test("labels nothing for user messages or missing info", () => {
  assert.deepEqual(messageProfileLabel(instanceId, { role: "user" } as MessageInfo), { text: "", exact: "" })
  assert.deepEqual(messageProfileLabel(instanceId, undefined), { text: "", exact: "" })
})
