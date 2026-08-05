import { agents, providers } from "./session-state"
import { getProviderModelVisibilityPreference, uiState, getAgentModelPreference } from "./preferences"
import { isModelVisible } from "../lib/model-visibility"

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

function isModelSelectable(
  instanceId: string,
  model?: { providerId: string; modelId: string } | null,
): model is { providerId: string; modelId: string } {
  return isModelValid(instanceId, model) && isModelVisible(
    getProviderModelVisibilityPreference(model.providerId),
    model.modelId,
  )
}

function getRecentModelPreferenceForInstance(
  instanceId: string,
): { providerId: string; modelId: string } | undefined {
  const recents = uiState().models.recents ?? []
  for (const item of recents) {
    if (isModelSelectable(instanceId, item)) {
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
    const agent = instanceAgents.find((a) => a.name === agentName)
    if (agent && agent.model && isModelSelectable(instanceId, agent.model)) {
      return {
        providerId: agent.model.providerId,
        modelId: agent.model.modelId,
      }
    }

    const stored = await getAgentModelPreference(instanceId, agentName)
    if (isModelSelectable(instanceId, stored)) {
      return stored
    }
  }

  const recent = getRecentModelPreferenceForInstance(instanceId)
  if (recent) {
    return recent
  }

  for (const provider of instanceProviders) {
    if (provider.defaultModelId) {
      const model = provider.models.find((m) =>
        m.id === provider.defaultModelId && isModelVisible(getProviderModelVisibilityPreference(provider.id), m.id),
      )
      if (model) {
        return {
          providerId: provider.id,
          modelId: model.id,
        }
      }
    }
  }

  for (const firstProvider of instanceProviders) {
    const firstModel = firstProvider.models.find((model) =>
      isModelVisible(getProviderModelVisibilityPreference(firstProvider.id), model.id),
    )
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
