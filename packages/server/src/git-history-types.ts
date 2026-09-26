export interface GitHistoryCommit {
  id: string
  parents: string[]
  author: string
  date: string
  subject: string
  refs: string
}

export interface GitHistoryPage {
  head: string | null
  branch: string | null
  commits: GitHistoryCommit[]
  hasMore: boolean
}

export interface GitCommitFile {
  path: string
  originalPath: string | null
  status: string
}

export interface GitCommitDetails {
  id: string
  parent: string | null
  message: string
  files: GitCommitFile[]
}

export interface GitCommitDiff {
  path: string
  before: string
  after: string
  isBinary: boolean
}
