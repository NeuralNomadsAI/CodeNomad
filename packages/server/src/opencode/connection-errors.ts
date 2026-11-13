/** Only a refused connection proves that the selected endpoint has no listener. */
export function isConnectionRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown }
  if (value.code === "ECONNREFUSED" || value.code === "ConnectionRefused") return true
  if (Array.isArray(value.errors) && value.errors.length) return value.errors.every(isConnectionRefused)
  return value.cause !== undefined && value.cause !== error && isConnectionRefused(value.cause)
}
