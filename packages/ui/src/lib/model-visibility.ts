export type ModelVisibilityPreference = { hiddenModelIds: readonly string[] }

export type ModelVisibilityPreferences = Record<string, ModelVisibilityPreference>

export function normalizeModelVisibilityPreference(value: unknown): ModelVisibilityPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { hiddenModelIds: [] }
  const hiddenModelIds = (value as { hiddenModelIds?: unknown }).hiddenModelIds
  if (!Array.isArray(hiddenModelIds)) return { hiddenModelIds: [] }

  return {
    hiddenModelIds: Array.from(new Set(hiddenModelIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
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
): boolean {
  return !normalizeModelVisibilityPreference(preference).hiddenModelIds.includes(modelId)
}
