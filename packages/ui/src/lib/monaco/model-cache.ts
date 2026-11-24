type MonacoApi = any

type CachedModel = {
  model: any
  /** Raw text last applied: Monaco's getValue() drops a BOM and normalizes mixed line endings. */
  value: string
  /** Model version after that text was applied; it moves when the model is edited. */
  version: number
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
    // An untouched model compares raw text, so identical content with a BOM or
    // mixed line endings is not rewritten (which would reset selection and the
    // diff view). An edited model keeps comparing its current text.
    const changed = existing.model.getVersionId() === existing.version
      ? existing.value !== params.value
      : existing.model.getValue() !== params.value
    if (changed) {
      existing.model.setValue(params.value)
    }
    existing.value = params.value
    existing.version = existing.model.getVersionId()
    return existing.model
  }

  const uri = params.monaco.Uri.parse(`opencode://model/${encodeURIComponent(params.cacheKey)}`)
  // Create as plaintext. We'll set the final language after its contribution is loaded.
  const model = params.monaco.editor.createModel(params.value, "plaintext", uri)
  const entry = { model, value: params.value, version: model.getVersionId() }
  models.set(params.cacheKey, entry)
  evictIfNeeded()
  return model
}
