import { createSignal } from "solid-js"
import { getLogger } from "./logger"
import { ERA_CODE_API_BASE } from "./api-client"

const log = getLogger("models-api")

// Use local proxy to avoid CORS issues
const MODELS_API_URL = `${ERA_CODE_API_BASE}/api/models/data`
const LOGO_BASE_URL = `${ERA_CODE_API_BASE}/api/models/logo`
const CACHE_DURATION = 30 * 60 * 1000 // 30 minutes (also cached server-side)

export interface ModelCost {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
}

export interface ModelLimit {
  context: number
  output: number
}

export interface ModelsDevModel {
  id: string
  name: string
  family: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  temperature?: boolean
  knowledge?: string
  release_date?: string
  last_updated?: string
  modalities?: {
    input: string[]
    output: string[]
  }
  open_weights?: boolean
  cost?: ModelCost
  limit?: ModelLimit
}

export interface ModelsDevProvider {
  id: string
  name: string
  env?: string[]
  npm?: string
  api?: string
  doc?: string
  models: Record<string, ModelsDevModel>
}

export type ModelsDevData = Record<string, ModelsDevProvider>

// Cache state
const [modelsData, setModelsData] = createSignal<ModelsDevData | null>(null)
const [lastFetchTime, setLastFetchTime] = createSignal<number>(0)
const [isLoading, setIsLoading] = createSignal(false)
const [fetchError, setFetchError] = createSignal<string | null>(null)

export function getModelsData() {
  return modelsData()
}

export function isModelsLoading() {
  return isLoading()
}

export function getModelsFetchError() {
  return fetchError()
}

export async function fetchModelsData(force = false): Promise<ModelsDevData | null> {
  const now = Date.now()
  const cached = modelsData()

  // Return cached data if still valid
  if (!force && cached && (now - lastFetchTime()) < CACHE_DURATION) {
    return cached
  }

  if (isLoading()) {
    // Wait for in-flight request
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!isLoading()) {
          clearInterval(checkInterval)
          resolve(modelsData())
        }
      }, 100)
    })
  }

  setIsLoading(true)
  setFetchError(null)

  try {
    const response = await fetch(MODELS_API_URL)
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`)
    }

    const data: ModelsDevData = await response.json()
    setModelsData(data)
    setLastFetchTime(now)
    log.info(`Fetched ${Object.keys(data).length} providers from models.dev`)
    return data
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    log.error("Failed to fetch models.dev data", error)
    setFetchError(message)
    return cached // Return stale cache if available
  } finally {
    setIsLoading(false)
  }
}

export function getProviderLogoUrl(providerId: string): string {
  // Server proxy handles the .svg extension
  return `${LOGO_BASE_URL}/${providerId}`
}

export function getAllProviders(): ModelsDevProvider[] {
  const data = modelsData()
  if (!data) return []
  return Object.values(data).sort((a, b) => a.name.localeCompare(b.name))
}

export function getProvider(providerId: string): ModelsDevProvider | undefined {
  const data = modelsData()
  return data?.[providerId]
}

export function getProviderModels(providerId: string): ModelsDevModel[] {
  const provider = getProvider(providerId)
  if (!provider) return []
  return Object.values(provider.models).sort((a, b) => a.name.localeCompare(b.name))
}

export function getModel(providerId: string, modelId: string): ModelsDevModel | undefined {
  const provider = getProvider(providerId)
  return provider?.models[modelId]
}

export interface SearchResult {
  provider: ModelsDevProvider
  model: ModelsDevModel
  score: number
}

export function searchModels(query: string, limit = 20): SearchResult[] {
  const data = modelsData()
  if (!data || !query.trim()) return []

  const normalizedQuery = query.toLowerCase().trim()
  const results: SearchResult[] = []

  for (const provider of Object.values(data)) {
    for (const model of Object.values(provider.models)) {
      let score = 0

      // Exact matches score highest
      if (model.id.toLowerCase() === normalizedQuery) score += 100
      if (model.name.toLowerCase() === normalizedQuery) score += 100

      // Prefix matches
      if (model.id.toLowerCase().startsWith(normalizedQuery)) score += 50
      if (model.name.toLowerCase().startsWith(normalizedQuery)) score += 50

      // Contains matches
      if (model.id.toLowerCase().includes(normalizedQuery)) score += 20
      if (model.name.toLowerCase().includes(normalizedQuery)) score += 20
      if (provider.name.toLowerCase().includes(normalizedQuery)) score += 10
      if (model.family?.toLowerCase().includes(normalizedQuery)) score += 5

      if (score > 0) {
        results.push({ provider, model, score })
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export function formatModelCost(cost: ModelCost | undefined): string {
  if (!cost) return "N/A"
  const input = cost.input ?? 0
  const output = cost.output ?? 0
  if (input === 0 && output === 0) return "Free"
  return `$${input}/$${output}`
}

export function formatModelLimit(limit: ModelLimit | undefined): string {
  if (!limit) return "N/A"
  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(0)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(0)}K`
    return n.toString()
  }
  return `${formatTokens(limit.context)} ctx / ${formatTokens(limit.output)} out`
}

// Popular providers to show at top of list
const POPULAR_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "mistral",
  "cohere",
  "groq",
]

export function getPopularProviders(): ModelsDevProvider[] {
  const data = modelsData()
  if (!data) return []

  return POPULAR_PROVIDERS
    .map(id => data[id])
    .filter((p): p is ModelsDevProvider => p !== undefined)
}
