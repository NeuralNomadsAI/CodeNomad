export function buildDirSave(
  clearKey: boolean,
  draftApiKey: string,
  draftBaseUrl: string,
  draftModel: string,
  sharedModel: string,
): { apiKey?: string | null; baseUrl?: string | null; model?: string | null } {
  if (clearKey) return { apiKey: null, baseUrl: null, model: null }
  const newKey = draftApiKey.trim()
  const modelMatchesShared = draftModel.trim() === sharedModel.trim()
  return {
    ...(newKey ? { apiKey: newKey } : {}),
    baseUrl: draftBaseUrl.trim() || null,
    model: modelMatchesShared ? null : (draftModel.trim() || null),
  }
}
