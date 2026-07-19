type GitHubWorkspaceContext = {
  installationId: number
  owner: string
  repo: string
  defaultBranch: string
  repoUrl: string
  botLogin?: string
}

const contexts = new Map<string, GitHubWorkspaceContext>()

export function setGitHubWorkspaceContext(workspaceId: string, context: GitHubWorkspaceContext) {
  contexts.set(workspaceId, context)
}

export function getGitHubWorkspaceContext(workspaceId: string): GitHubWorkspaceContext | undefined {
  return contexts.get(workspaceId)
}

export function clearGitHubWorkspaceContext(workspaceId: string) {
  contexts.delete(workspaceId)
}
