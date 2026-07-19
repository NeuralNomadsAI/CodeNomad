export type GitHubCommandMap = Record<string, string>

export type GitHubWebhookCommandSelection = {
  command: string
  source: "server" | "builtin"
}

const BUILTIN_COMMANDS: GitHubCommandMap = {
  default: "codenomad-github-default",
  "issue_comment.created": "codenomad-github-issue-comment",
  "pull_request_review_comment.created": "codenomad-github-review-comment",
  "issues.opened": "codenomad-github-issue-opened",
  "pull_request.opened": "codenomad-github-pr-opened",
}

export function selectGitHubWebhookCommand(params: {
  eventKey: string
  serverCommands: GitHubCommandMap
}): GitHubWebhookCommandSelection {
  const server = normalizeCommandMap(params.serverCommands)
  const serverHit = server[params.eventKey] ?? server.default
  if (serverHit) {
    return { command: serverHit, source: "server" }
  }

  const builtinHit = BUILTIN_COMMANDS[params.eventKey] ?? BUILTIN_COMMANDS.default
  return { command: builtinHit, source: "builtin" }
}

function normalizeCommandMap(input: unknown): GitHubCommandMap {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const out: GitHubCommandMap = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof k !== "string" || typeof v !== "string") continue
    const key = k.trim()
    const value = v.trim()
    if (!key || !value) continue
    out[key] = value
  }
  return out
}
