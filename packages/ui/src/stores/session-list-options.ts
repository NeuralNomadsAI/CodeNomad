export const PROJECT_SESSION_LIST_LIMIT = 10000

type ProjectSessionListInput = {
  project: string
  search?: string
  cursor?: string
}

export type ProjectSessionListOptions = ProjectSessionListInput & {
  limit: typeof PROJECT_SESSION_LIST_LIMIT
  order: "asc"
}

type SessionDirectorySource = {
  location?: { directory?: string | null }
}

export function normalizeSessionDirectory(directory: string | null | undefined): string {
  const trimmed = directory?.trim()
  if (!trimmed) return ""

  const slashNormalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "")
  const comparable = slashNormalized || "/"
  const isWindowsPath = /^[A-Za-z]:\//.test(comparable) || comparable.startsWith("//") || trimmed.includes("\\")

  return isWindowsPath ? comparable.toLowerCase() : comparable
}

export function buildProjectSessionListOptions(options: ProjectSessionListInput): ProjectSessionListOptions {
  return {
    project: options.project,
    ...(options.search ? { search: options.search } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    limit: PROJECT_SESSION_LIST_LIMIT,
    order: "asc",
  }
}

export function filterProjectScopedSessions<T extends SessionDirectorySource>(
  sessions: T[],
  allowedDirectories: Array<string | null | undefined>,
): T[] {
  const allowed = new Set(allowedDirectories.map(normalizeSessionDirectory).filter(Boolean))
  if (allowed.size === 0) return sessions

  return sessions.filter((session) => {
    const directory = normalizeSessionDirectory(session.location?.directory)
    return !directory || allowed.has(directory)
  })
}

export function getAuthoritativelyMissingSessionIds(
  existingIds: Iterable<string>,
  listedIds: Iterable<string>,
  complete: boolean,
): string[] {
  if (!complete) return []
  const listed = new Set(listedIds)
  return Array.from(existingIds).filter((id) => !listed.has(id))
}
