export const PROJECT_SESSION_LIST_LIMIT = 1000

type ProjectSessionListInput = {
  directory?: string
  search?: string
}

export type ProjectSessionListOptions = ProjectSessionListInput & {
  limit: typeof PROJECT_SESSION_LIST_LIMIT
}

export function buildProjectSessionListOptions(options: ProjectSessionListInput): ProjectSessionListOptions {
  return {
    ...(options.directory ? { directory: options.directory } : {}),
    ...(options.search ? { search: options.search } : {}),
    limit: PROJECT_SESSION_LIST_LIMIT,
  }
}
