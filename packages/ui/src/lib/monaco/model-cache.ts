type MonacoApi = any

type CachedModel = {
  model: any
}

const MAX_MODELS = 5

// LRU map: newest at the end.
const models = new Map<string, CachedModel>()

function touch(key: string, entry: CachedModel) {
  models.delete(key)
  models.set(key, entry)
}

function evictIfNeeded() {
  while (models.size > MAX_MODELS) {
    const oldestKey = models.keys().next().value as string | undefined
    if (!oldestKey) return
    const entry = models.get(oldestKey)
    models.delete(oldestKey)
    try {
      entry?.model.dispose()
    } catch {
      // ignore
    }
  }
}

export function getOrCreateTextModel(params: {
  monaco: MonacoApi
  cacheKey: string
  value: string
  languageId: string
}): any {
  const existing = models.get(params.cacheKey)
  if (existing) {
    touch(params.cacheKey, existing)
    if (existing.model.getValue() !== params.value) {
      existing.model.setValue(params.value)
    }
    return existing.model
  }

  const uri = params.monaco.Uri.parse(`opencode://model/${encodeURIComponent(params.cacheKey)}`)
  // Create as plaintext. We'll set the final language after its contribution is loaded.
  const model = params.monaco.editor.createModel(params.value, "plaintext", uri)
  const entry = { model }
  models.set(params.cacheKey, entry)
  evictIfNeeded()
  return model
}
