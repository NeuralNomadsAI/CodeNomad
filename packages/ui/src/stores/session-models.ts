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
  // Use "main" as default agent name if not provided
  const effectiveAgentName = agentName || "main"

  // 1. Check if agent has a model from CLI response
  const agent = instanceAgents.find((a) => a.name === effectiveAgentName)
  if (agent && agent.model && isModelValid(instanceId, agent.model)) {
    return {
      providerId: agent.model.providerId,
      modelId: agent.model.modelId,
    }
  }

  // 2. Check per-instance stored preference for this agent
  const stored = await getAgentModelPreference(instanceId, effectiveAgentName)
  if (isModelValid(instanceId, stored)) {
    return stored
  }

  // 3. Check global agent model defaults (from Settings > Models)
  const globalDefaults = preferences().modelDefaultsByAgent ?? {}
  const globalDefault = globalDefaults[effectiveAgentName]
  if (isModelValid(instanceId, globalDefault)) {
    return {
      providerId: globalDefault.providerId,
      modelId: globalDefault.modelId,
    }
  }

  // 4. Check recent model preference
  const recent = getRecentModelPreferenceForInstance(instanceId)
  if (recent) {
    return recent
  }

  // 5. Use provider's default model
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

  // 6. Fall back to first provider's first model
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
