import type { IntegrationInfo, ModelInfo, ProviderInfo } from "@opencode-ai/client"

export type ListedProvider = {
  id: string
  name: string
  modelCount: number
  source: "env" | "config" | "custom" | "api" | "unknown"
  credentialIds: string[]
  canConnect: boolean
}

export function buildListedProviders(
  providers: ProviderInfo[],
  models: ModelInfo[],
  integrations: IntegrationInfo[],
): ListedProvider[] {
  const modelsByProvider = new Map<string, number>()
  for (const model of models) {
    modelsByProvider.set(model.providerID, (modelsByProvider.get(model.providerID) ?? 0) + 1)
  }

  const matchedProviderIds = new Set<string>()
  const listed = integrations.map((integration): ListedProvider => {
    const matchingProviders = providers.filter((provider) => (provider.integrationID ?? provider.id) === integration.id)
    for (const provider of matchingProviders) matchedProviderIds.add(provider.id)
    const credentialIds = integration.connections
      .filter((connection) => connection.type === "credential")
      .map((connection) => connection.id)
    return {
      id: integration.id,
      name: integration.name,
      modelCount: matchingProviders.reduce((count, provider) => count + (modelsByProvider.get(provider.id) ?? 0), 0),
      source: credentialIds.length > 0
        ? "api"
        : integration.connections.some((connection) => connection.type === "env")
          ? "env"
          : matchingProviders.length > 0 ? "config" : "unknown",
      credentialIds,
      canConnect: integration.methods.some((method) => method.type !== "env"),
    }
  })

  const listedIds = new Set(listed.map((provider) => provider.id))
  for (const provider of providers) {
    if (matchedProviderIds.has(provider.id) || listedIds.has(provider.id)) continue
    listed.push({
      id: provider.id,
      name: provider.name || provider.id,
      modelCount: modelsByProvider.get(provider.id) ?? 0,
      source: "custom",
      credentialIds: [],
      canConnect: false,
    })
    listedIds.add(provider.id)
  }
  for (const [providerId, modelCount] of modelsByProvider) {
    if (matchedProviderIds.has(providerId) || listedIds.has(providerId)) continue
    listed.push({ id: providerId, name: providerId, modelCount, source: "unknown", credentialIds: [], canConnect: false })
  }

  return listed
}
