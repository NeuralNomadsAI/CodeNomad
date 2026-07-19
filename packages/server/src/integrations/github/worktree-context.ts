type GitHubWorktreeContext = {
  issueNumber: number
  isPullRequest: boolean
  publishBase: string
  prNumber?: number
  prFromFork?: boolean
  prAuthorLogin?: string
}

const contexts = new Map<string, Map<string, GitHubWorktreeContext>>()

export function setGitHubWorktreeContext(workspaceId: string, worktreeSlug: string, context: GitHubWorktreeContext) {
  const scoped = contexts.get(workspaceId) ?? new Map<string, GitHubWorktreeContext>()
  scoped.set(worktreeSlug, context)
  contexts.set(workspaceId, scoped)
}

export function getGitHubWorktreeContext(workspaceId: string, worktreeSlug: string): GitHubWorktreeContext | undefined {
  return contexts.get(workspaceId)?.get(worktreeSlug)
}

export function clearGitHubWorktreeContext(workspaceId: string) {
  contexts.delete(workspaceId)
}
