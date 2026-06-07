export type RightPanelTab = "changes" | "git-changes" | "files" | "status"

export type DiffViewMode = "split" | "unified"

export type DiffContextMode = "expanded" | "collapsed"

export type DiffWordWrapMode = "on" | "off"

export type GitChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | string

export interface GitChangeEntry {
  path: string
  originalPath?: string | null
  additions: number
  deletions: number
  status: GitChangeStatus
  stagedStatus?: GitChangeStatus | null
  unstagedStatus?: GitChangeStatus | null
  stagedAdditions?: number
  stagedDeletions?: number
  unstagedAdditions?: number
  unstagedDeletions?: number
}

export type GitChangeSection = "staged" | "unstaged"

export interface GitChangeListItem {
  id: string
  path: string
   originalPath?: string | null
  section: GitChangeSection
  status: GitChangeStatus
  additions: number
  deletions: number
  entry: GitChangeEntry
  displayName: string
  parentPath: string
}

export interface GitSelectionDescriptor {
  itemId: string | null
  path: string | null
  section: GitChangeSection | null
}
