import assert from "node:assert/strict"
import { test } from "node:test"
import type { MessageInfo } from "../types/message"
import { agents, providers, setAgents, setProviders } from "../stores/session-state"
import { assistantAgentMeta, assistantAgentMetaTooltip } from "./assistant-meta"

test("reasoning tooltips distinguish providers sharing a model display name", () => {
  const previousAgents = agents(), previousProviders = providers()
  const instanceId = "assistant-meta"
  const info = (providerID: string): MessageInfo => ({
    id: "message", sessionID: "session", role: "assistant", mode: "build",
    providerID, modelID: "shared", time: { created: 1 },
  }) as MessageInfo
  try {
    setAgents(new Map([[instanceId, [{ id: "build", name: "Builder" }]]]) as any)
    setProviders(new Map([[instanceId, ["p1", "p2"].map(id => ({
      id, name: id, models: [{ id: "shared", name: "Shared Model" }],
    }))]]) as any)
    for (const providerID of ["p1", "p2"]) {
      assert.equal(assistantAgentMeta(instanceId, info(providerID)), "Builder • Shared Model",
        "visible labels stay friendly")
      assert.equal(assistantAgentMetaTooltip(instanceId, info(providerID)), `Builder • Shared Model\n${providerID}/shared`)
    }
    assert.equal(assistantAgentMetaTooltip(instanceId, { ...info("p1"), variant: " high " }),
      "Builder • Shared Model • high\np1/shared")
    assert.equal(assistantAgentMetaTooltip(instanceId, info("unknown")), "Builder • unknown/shared",
      "an already qualified fallback is not repeated")
    assert.equal(assistantAgentMetaTooltip(instanceId, undefined), "")
    assert.equal(assistantAgentMetaTooltip(instanceId, { ...info("p1"), role: "user" } as MessageInfo), "")
  } finally {
    setAgents(previousAgents)
    setProviders(previousProviders)
  }
})
