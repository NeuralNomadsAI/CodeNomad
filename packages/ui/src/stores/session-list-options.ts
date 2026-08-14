export const PROJECT_SESSION_LIST_LIMIT = 10000

type ProjectSessionListInput = {
  directory?: string
  search?: string
}

export type ProjectSessionListOptions = ProjectSessionListInput & {
  limit: typeof PROJECT_SESSION_LIST_LIMIT
}

function normalizeSessionDirectory(directory: string | null | undefined): string {
  const trimmed = directory?.trim()
  if (!trimmed) return ""

  const slashNormalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "")
  const comparable = slashNormalized || "/"
  const isWindowsPath = /^[A-Za-z]:\//.test(comparable) || comparable.startsWith("//") || trimmed.includes("\\")

  return isWindowsPath ? comparable.toLowerCase() : comparable
}

export function buildProjectSessionListOptions(options: ProjectSessionListInput): ProjectSessionListOptions {
  return {
    ...(options.directory ? { directory: options.directory } : {}),
    ...(options.search ? { search: options.search } : {}),
    limit: PROJECT_SESSION_LIST_LIMIT,
  }
}

export function getUniqueSessionDirectories(
  directories: Array<string | null | undefined>,
): string[] {
  const unique = new Map<string, string>()
  for (const directory of directories) {
    const normalized = normalizeSessionDirectory(directory)
    if (normalized && !unique.has(normalized)) unique.set(normalized, directory!.trim())
  }
  return Array.from(unique.values())
}
