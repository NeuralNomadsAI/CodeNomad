export function normalizeWorkspacePath(folderPath: string): string {
  const windowsLike = /^(?:[A-Za-z]:[/\\]|[/\\]{2})/.test(folderPath)
  const normalized = windowsLike ? folderPath.replace(/\\/g, "/").toLowerCase() : folderPath
  return normalized === "/" || /^[a-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, "")
}
