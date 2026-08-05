export type ModelVisibilityPreference =
  | { mode: "all" }
  | { mode: "custom"; modelIds: readonly string[] }

export type ModelVisibilityPreferences = Record<string, ModelVisibilityPreference>

export function normalizeModelVisibilityPreference(value: unknown): ModelVisibilityPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { mode: "all" }
  const candidate = value as { mode?: unknown; modelIds?: unknown }
  if (candidate.mode === "all") return { mode: "all" }
  if (candidate.mode !== "custom" || !Array.isArray(candidate.modelIds)) return { mode: "all" }

  return {
    mode: "custom",
    modelIds: Array.from(new Set(candidate.modelIds.filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0,
    ))),
  }
}

export function normalizeModelVisibilityPreferences(value: unknown): ModelVisibilityPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: ModelVisibilityPreferences = {}
  for (const [providerId, preference] of Object.entries(value as Record<string, unknown>)) {
    if (!providerId) continue
    result[providerId] = normalizeModelVisibilityPreference(preference)
  }
  return result
}

export function isModelVisible(
  preference: ModelVisibilityPreference | undefined,
  modelId: string,
  currentModelId?: string,
): boolean {
  if (modelId === currentModelId) return true
  const normalized = normalizeModelVisibilityPreference(preference)
  return normalized.mode === "all" || normalized.modelIds.includes(modelId)
}

export function getUnavailableSelectedModelIds(
  preference: ModelVisibilityPreference | undefined,
  currentModelIds: readonly string[],
): string[] {
  const normalized = normalizeModelVisibilityPreference(preference)
  if (normalized.mode === "all") return []
  const current = new Set(currentModelIds)
  return normalized.modelIds.filter((id) => !current.has(id))
}

export function seedCustomModelVisibility(currentModelIds: readonly string[]): ModelVisibilityPreference {
  return normalizeModelVisibilityPreference({ mode: "custom", modelIds: currentModelIds })
}
