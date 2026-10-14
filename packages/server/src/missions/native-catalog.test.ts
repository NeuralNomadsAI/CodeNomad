import assert from "node:assert/strict"
import test from "node:test"
import { parseExecution } from "./execution"
import { readMissionCatalog, validateNativeExecution, type MissionCatalogClient } from "./native-catalog"

test("discovers native identities at the requested location and validates runnable selections", async () => {
  const locations: string[] = []
  const client: MissionCatalogClient = {
    agent: { list: async input => {
      locations.push(input.location.directory)
      return { data: [{ id: "review", mode: "all" }, { id: "explore", mode: "subagent" }, { id: "build", mode: "primary" }, { id: "title", hidden: true }] } as never
    } },
    model: { list: async input => {
      locations.push(input.location.directory)
      return { data: [
        { providerID: "fixture", id: "reasoner", enabled: true, capabilities: { tools: true }, variants: [{ id: "high" }] },
        { providerID: "fixture", id: "disabled", enabled: false, capabilities: { tools: true }, variants: [] },
      ] } as never
    } },
  }
  const catalog = await readMissionCatalog(client, "/worktree")
  assert.deepEqual(locations, ["/worktree", "/worktree"])
  assert.deepEqual(catalog.agents.map(agent => agent.id), ["review", "explore", "build"])
  assert.equal(catalog.models.length, 1)
  const input = { taskKey: "review", title: "Review", brief: "Inspect", role: "reviewer", blockedBy: [], delivery: "queue" as const }
  await validateNativeExecution(client, "/worktree", { ...input, execution: { agent: "review", model: { providerID: "fixture", id: "reasoner", variant: "high" } } })
  await assert.rejects(validateNativeExecution(client, "/worktree", { ...input, execution: { agent: "explore" } }), /child-only/)
  const native = { kind: "native", parentTaskKey: null } as const
  const independent = { kind: "independent", reason: "playbook", explanation: "Explicit lifetime exception" } as const
  await validateNativeExecution(client, "/worktree", { executionMode: native, execution: { agent: "explore" } })
  await validateNativeExecution(client, "/worktree", { executionMode: native, execution: { agent: "review" } })
  await assert.rejects(validateNativeExecution(client, "/worktree", { executionMode: native, execution: { agent: "build" } }), /subagent\/all/)
  await validateNativeExecution(client, "/worktree", { executionMode: independent, execution: { agent: "build" } })
  await validateNativeExecution(client, "/worktree", { executionMode: independent, execution: { agent: "review" } })
  await assert.rejects(validateNativeExecution(client, "/worktree", { executionMode: independent, execution: { agent: "explore" } }), /primary\/all/)
  await assert.rejects(validateNativeExecution(client, "/worktree", { executionMode: native, execution: { agent: "title" } }), /visible/)
  await assert.rejects(validateNativeExecution(client, "/worktree", { ...input, execution: { model: { providerID: "fixture", id: "reasoner", variant: "missing" } } }), /variant/)
  await assert.rejects(validateNativeExecution(client, "/worktree", { ...input, execution: { model: { providerID: "fixture", id: "disabled" } } }), /enabled/)
  assert.throws(() => parseExecution({ model: { providerID: "fixture" } }), /identifier/)
  assert.throws(() => parseExecution({ model: { providerID: "fixture", id: "reasoner", apiKey: "not-allowed" } }), /Unknown/)
})
