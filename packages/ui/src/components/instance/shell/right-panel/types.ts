export type RightPanelTab = "changes" | "git-changes" | "files" | "status"

export type DiffViewMode = "split" | "unified"

export type DiffContextMode = "expanded" | "collapsed"

export type DiffWordWrapMode = "on" | "off"

export type GitChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | string

export interface GitChangeEntry {
  path: string
  additions: number
  deletions: number
  status: GitChangeStatus
  stagedStatus?: GitChangeStatus | null
  unstagedStatus?: GitChangeStatus | null
}
