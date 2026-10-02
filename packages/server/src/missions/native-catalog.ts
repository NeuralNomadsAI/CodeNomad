import type { AgentListOutput, ModelListOutput } from "@opencode/client"
import type { MissionDelegateInput } from "./control-types"

export interface MissionCatalogClient {
  agent: { list(input: { location: { directory: string } }): Promise<AgentListOutput> }
  model: { list(input: { location: { directory: string } }): Promise<ModelListOutput> }
}

export async function readMissionCatalog(client: MissionCatalogClient, directory: string) {
  const [agents, models] = await Promise.all([
    client.agent.list({ location: { directory } }), client.model.list({ location: { directory } }),
  ])
  return {
    agents: agents.data.filter(agent => !agent.hidden).map(({ id, mode, description }) => ({ id, mode, description })),
    models: models.data.filter(model => model.enabled && model.capabilities.tools)
      .map(({ providerID, id, variants }) => ({ providerID, id, variants: variants.map(variant => variant.id) })),
  }
}

export async function validateNativeExecution(client: MissionCatalogClient, directory: string, input: MissionDelegateInput) {
  if (!input.execution) return
  const catalog = await readMissionCatalog(client, directory)
  if (input.execution.agent) {
    const agent = catalog.agents.find(agent => agent.id === input.execution!.agent)
    if (!agent || agent.mode === "subagent") {
      throw new Error("Choose a visible primary/all agent for a mission actor; use native subagent for child-only profiles")
    }
  }
  if (input.execution.model) {
    const selected = input.execution.model
    const model = catalog.models.find(model => model.providerID === selected.providerID && model.id === selected.id)
    if (!model || (selected.variant !== undefined && !model.variants.includes(selected.variant))) {
      throw new Error("Choose an enabled tool-capable model and variant from the native catalog")
    }
  }
}
