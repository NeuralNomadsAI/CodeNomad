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
  limit: typeof PROJECT_SESSION_LIST_LIMIT
}

export function buildProjectSessionListOptions(options: ProjectSessionListInput): ProjectSessionListOptions {
  return {
    ...(options.directory ? { directory: options.directory } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.project ? { project: options.project } : {}),
    ...(options.subpath ? { subpath: options.subpath } : {}),
    ...(options.parentID !== undefined ? { parentID: options.parentID } : {}),
    ...(options.order ? { order: options.order } : {}),
    limit: PROJECT_SESSION_LIST_LIMIT,
  }
}
