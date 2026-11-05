export const LOCAL_SERVER_ID = "local-shared"

export function isServerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}

export function normalizeLocalProjectPath(folder: string): string {
  const windowsLike = /^(?:[A-Za-z]:[/\\]|[/\\]{2})/.test(folder)
  const normalized = windowsLike ? folder.replace(/\\/g, "/").toLowerCase() : folder
  return normalized === "/" || /^[a-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, "")
}

/** Durable display identity; remote directories are opaque, including spelling. */
export function projectIdentity(folder: string, serverId = LOCAL_SERVER_ID): string {
  return JSON.stringify([serverId, serverId === LOCAL_SERVER_ID ? normalizeLocalProjectPath(folder) : folder])
}
