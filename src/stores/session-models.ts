import { agents, providers } from "./session-state"
import { preferences, getAgentModelPreference } from "./preferences"

const DEFAULT_MODEL_OUTPUT_LIMIT = 32_000

function isModelValid(
  instanceId: string,
  model?: { providerId: string; modelId: string } | null,
): model is { providerId: string; modelId: string } {
  if (!model?.providerId || !model.modelId) return false
  const instanceProviders = providers().get(instanceId) || []
  const provider = instanceProviders.find((p) => p.id === model.providerId)
  if (!provider) return false
  return provider.models.some((item) => item.id === model.modelId)
}

function getRecentModelPreferenceForInstance(
  instanceId: string,
): { providerId: string; modelId: string } | undefined {
  const recents = preferences().modelRecents ?? []
  for (const item of recents) {
    if (isModelValid(instanceId, item)) {
      return item
    }
  }
}

async function getDefaultModel(
  instanceId: string,
  agentName?: string,
): Promise<{ providerId: string; modelId: string }> {
  const instanceProviders = providers().get(instanceId) || []
  const instanceAgents = agents().get(instanceId) || []

  if (agentName) {
    const stored = getAgentModelPreference(instanceId, agentName)
    if (isModelValid(instanceId, stored)) {
      return stored
    }
  }

  if (agentName) {
    const agent = instanceAgents.find((a) => a.name === agentName)
    if (agent && agent.model && isModelValid(instanceId, agent.model)) {
      return {
        providerId: agent.model.providerId,
        modelId: agent.model.modelId,
      }
    }
  }

  const recent = getRecentModelPreferenceForInstance(instanceId)
  if (recent) {
    return recent
  }

  for (const provider of instanceProviders) {
    if (provider.defaultModelId) {
      const model = provider.models.find((m) => m.id === provider.defaultModelId)
      if (model) {
        return {
          providerId: provider.id,
          modelId: model.id,
        }
      }
    }
  }

  if (instanceProviders.length > 0) {
    const firstProvider = instanceProviders[0]
    const firstModel = firstProvider.models[0]
    if (firstModel) {
      return {
        providerId: firstProvider.id,
        modelId: firstModel.id,
      }
    }
  }

  return { providerId: "", modelId: "" }
}

export { DEFAULT_MODEL_OUTPUT_LIMIT, getDefaultModel, getRecentModelPreferenceForInstance, isModelValid }
