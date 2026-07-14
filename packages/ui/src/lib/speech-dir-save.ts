export function buildDirSave(
  clearKey: boolean,
  draftApiKey: string,
  draftBaseUrl: string,
  draftModel: string,
  storedBaseUrl: string | undefined,
  sharedModel: string,
): { apiKey?: string | null; baseUrl?: string | null; model?: string | null } {
  if (clearKey) return { apiKey: null, baseUrl: null, model: null }
  const newKey = draftApiKey.trim()
  const baseUrlChanged = (draftBaseUrl.trim() || "") !== (storedBaseUrl || "")
  const modelMatchesShared = draftModel.trim() === sharedModel.trim()
  if (baseUrlChanged) {
    return {
      ...(newKey ? { apiKey: newKey } : { apiKey: null }),
      baseUrl: draftBaseUrl.trim() || null,
      model: modelMatchesShared ? null : (draftModel.trim() || null),
    }
  }
  return {
    ...(newKey ? { apiKey: newKey } : {}),
    model: modelMatchesShared ? null : (draftModel.trim() || null),
  }
}
