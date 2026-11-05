import type { LocationRef } from "@opencode/client"
import { activeSessionId, agents, providers, sessions } from "./session-state"
import { uiState, getAgentModelPreference } from "./preferences"
import { instances } from "./instances"
import { getRootClient } from "./opencode-client"
import { resolveAgentId } from "../types/session"
import { requestConnectionOptions, requestLocationOptions, toRequestLocation } from "./request-locations"
import { LOCAL_SERVER_ID } from "../lib/project-identity"
import { captureInstanceRequestAuthority } from "./session-api"
import { explicitSessionDirectory } from "./session-inventory-scope"
import { tGlobal } from "../lib/i18n"

const DEFAULT_MODEL_OUTPUT_LIMIT = 32_000

function getActiveCatalogLocation(instanceId: string): LocationRef {
  const instance = instances().get(instanceId)
  const explicit = explicitSessionDirectory(instance)
  if (explicit !== undefined) return { directory: explicit }
  const selectedId = activeSessionId().get(instanceId)
  const selectedLocation = selectedId && selectedId !== "info"
    ? sessions().get(instanceId)?.get(selectedId)?.location
    : undefined
  return selectedLocation ?? { directory: instance?.folder ?? "" }
}

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
  const recents = uiState().models.recents ?? []
  for (const item of recents) {
    if ((item.serverId ?? LOCAL_SERVER_ID) === (instances().get(instanceId)?.binding?.serverId ?? LOCAL_SERVER_ID) && isModelValid(instanceId, item)) {
      return item
    }
  }
}

async function getDefaultModel(
  instanceId: string,
  agentName?: string,
  location = getActiveCatalogLocation(instanceId),
): Promise<{ providerId: string; modelId: string }> {
  const current = captureInstanceRequestAuthority(instanceId)
  const client = instances().get(instanceId)?.client ? getRootClient(instanceId) : undefined
  const requestOptions = requestConnectionOptions(instances().get(instanceId)) ?? requestLocationOptions(location)
  const assertCurrent = () => { if (!current()) throw new Error(tGlobal("session.actions.superseded")) }
  const instanceProviders = providers().get(instanceId) || []
  const instanceAgents = agents().get(instanceId) || []
  const agentId = agentName ? resolveAgentId(instanceAgents, agentName) : ""

  if (agentId) {
    const agent = instanceAgents.find((a) => a.id === agentId)
    if (agent && agent.model && isModelValid(instanceId, agent.model)) {
      return {
        providerId: agent.model.providerId,
        modelId: agent.model.modelId,
      }
    }

    const stored = await getAgentModelPreference(instanceId, agentId, current)
    assertCurrent()
    if (isModelValid(instanceId, stored)) {
      return stored
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

  if (!instanceProviders.some((provider) => provider.models.length > 0)) {
    if (client) {
      assertCurrent()
      const response = await client.model.default({
        location: toRequestLocation(location),
      }, requestOptions).catch(() => null)
      assertCurrent()
      if (response?.data) {
        return { providerId: response.data.providerID, modelId: response.data.id }
      }
    }
  }

  return { providerId: "", modelId: "" }
}

export { DEFAULT_MODEL_OUTPUT_LIMIT, getActiveCatalogLocation, getDefaultModel, getRecentModelPreferenceForInstance, isModelValid }
