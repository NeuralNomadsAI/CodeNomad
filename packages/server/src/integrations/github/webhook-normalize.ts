export type GitHubWebhookContext = {
  owner: string
  repo: string
  repoFullName: string
  installationId: number
  repoUrl: string
  defaultBranch: string
  isPullRequest: boolean
  number: number
  bodyText: string
  actorLogin?: string
  actorAssociation?: string
  actorType?: string
  prAuthorLogin?: string
  issueCommentId?: number
  reviewCommentId?: number
}

export function normalizeGitHubWebhookContext(params: { event: string; payload: any }): GitHubWebhookContext | null {
  const payload = params.payload
  const owner = payload?.repository?.owner?.login
  const repo = payload?.repository?.name
  const installationId = payload?.installation?.id
  if (!owner || !repo || typeof installationId !== "number") return null

  const defaultBranch = (payload?.repository?.default_branch ?? "main").toString().trim() || "main"
  const repoUrl = (payload?.repository?.clone_url ?? "").toString().trim() || `https://github.com/${owner}/${repo}.git`

  if (params.event === "issue_comment") {
    const number = payload?.issue?.number
    if (typeof number !== "number") return null
    const commentId = payload?.comment?.id
    return {
      owner,
      repo,
      repoFullName: `${owner}/${repo}`,
      installationId,
      repoUrl,
      defaultBranch,
      isPullRequest: Boolean(payload?.issue?.pull_request),
      number,
      bodyText: (payload?.comment?.body ?? "").toString(),
      actorLogin: payload?.comment?.user?.login,
      actorAssociation: payload?.comment?.author_association,
      actorType: payload?.comment?.user?.type,
      issueCommentId: typeof commentId === "number" ? commentId : undefined,
    }
  }

  if (params.event === "pull_request_review_comment") {
    const number = payload?.pull_request?.number
    if (typeof number !== "number") return null
    const commentId = payload?.comment?.id
    return {
      owner,
      repo,
      repoFullName: `${owner}/${repo}`,
      installationId,
      repoUrl,
      defaultBranch,
      isPullRequest: true,
      number,
      bodyText: (payload?.comment?.body ?? "").toString(),
      actorLogin: payload?.comment?.user?.login,
      actorAssociation: payload?.comment?.author_association,
      actorType: payload?.comment?.user?.type,
      reviewCommentId: typeof commentId === "number" ? commentId : undefined,
    }
  }

  if (params.event === "issues") {
    const number = payload?.issue?.number
    if (typeof number !== "number") return null
    return {
      owner,
      repo,
      repoFullName: `${owner}/${repo}`,
      installationId,
      repoUrl,
      defaultBranch,
      isPullRequest: Boolean(payload?.issue?.pull_request),
      number,
      bodyText: (payload?.issue?.body ?? "").toString(),
      actorLogin: payload?.issue?.user?.login,
      actorAssociation: payload?.issue?.author_association,
      actorType: payload?.issue?.user?.type,
    }
  }

  if (params.event === "pull_request") {
    const number = payload?.pull_request?.number
    if (typeof number !== "number") return null
    const action = (payload?.action ?? "").toString().trim().toLowerCase()
    const actorUser = action === "synchronize" ? payload?.sender : payload?.pull_request?.user
    const senderAssociation = payload?.sender?.author_association
    const actorAssociation = action === "synchronize"
      ? (typeof senderAssociation === "string" ? senderAssociation : undefined)
      : payload?.pull_request?.author_association
    const prAuthorLogin = payload?.pull_request?.user?.login
    return {
      owner,
      repo,
      repoFullName: `${owner}/${repo}`,
      installationId,
      repoUrl,
      defaultBranch,
      isPullRequest: true,
      number,
      bodyText: (payload?.pull_request?.body ?? "").toString(),
      actorLogin: actorUser?.login,
      actorAssociation,
      actorType: actorUser?.type,
      prAuthorLogin: typeof prAuthorLogin === "string" ? prAuthorLogin : undefined,
    }
  }

  return null
}
