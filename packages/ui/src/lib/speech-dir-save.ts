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
  return {
    ...(newKey ? { apiKey: newKey } : {}),
    ...(baseUrlChanged ? { baseUrl: draftBaseUrl.trim() || null } : {}),
    model: modelMatchesShared ? null : (draftModel.trim() || null),
  }
}
