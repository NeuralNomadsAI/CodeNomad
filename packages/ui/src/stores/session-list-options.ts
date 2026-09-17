export const PROJECT_SESSION_LIST_LIMIT = 200

type ProjectSessionListInput = {
  directory?: string
  search?: string
  cursor?: string
  project?: string
  subpath?: string
  parentID?: string | null
  order?: "asc" | "desc"
}

export type ProjectSessionListOptions = ProjectSessionListInput & {
  limit?: typeof PROJECT_SESSION_LIST_LIMIT
}

export function normalizeSessionDirectory(directory: string | null | undefined): string {
  const trimmed = directory?.trim()
  if (!trimmed) return ""

  const slashNormalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "")
  const comparable = slashNormalized || "/"
  const wsl = comparable.match(/^\/\/(wsl(?:\.localhost|\$)?)[/]([^/]+)(.*)$/i)
  if (wsl) return `//${wsl[1]!.toLowerCase()}/${wsl[2]!.toLowerCase()}${wsl[3]}`
  const isWindowsPath = /^[A-Za-z]:\//.test(comparable) || comparable.startsWith("//") || trimmed.includes("\\")

  return isWindowsPath ? comparable.toLowerCase() : comparable
}

export function buildProjectSessionListOptions(options: ProjectSessionListInput): ProjectSessionListOptions {
  if (options.cursor) return { cursor: options.cursor }
  return {
    ...(options.directory ? { directory: options.directory } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.project ? { project: options.project } : {}),
    ...(options.subpath ? { subpath: options.subpath } : {}),
    ...(options.parentID !== undefined ? { parentID: options.parentID } : {}),
    ...(options.order ? { order: options.order } : {}),
    limit: PROJECT_SESSION_LIST_LIMIT,
  }
}
