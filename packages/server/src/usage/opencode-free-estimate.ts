// ponytail: the daily reference is observed, not supplied by the Console API.
// Replace it with an upstream allowance when that contract becomes available.
export const OPENCODE_FREE_DAILY_REQUESTS = 800

export function isOpenCodeFreeModel(providerId: string, modelId?: string): boolean {
  const model = modelId?.trim().toLowerCase()
  return providerId.trim().toLowerCase() === "opencode" && !!model && (model === "big-pickle" || model.endsWith("-free"))
}
