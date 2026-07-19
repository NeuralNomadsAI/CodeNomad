type PolicyMatch = {
  repo?: string
  repoRegex?: string
  event?: string
  eventRegex?: string
}

export type GitHubWebhookPolicyRule = {
  name?: string
  match?: PolicyMatch
  allow?: {
    enabled?: boolean
    requireMention?: boolean
    allowPrAuthor?: boolean
    allowAllActors?: boolean
    denyBots?: boolean
    allowedUsers?: string[]
    allowedAuthorAssociations?: string[]
    command?: string
    agent?: string
    model?: { providerId: string; modelId: string }
    variant?: string
  }
}

export type GitHubWebhookPolicyDecision = {
  ruleName?: string
  enabled: boolean
  requireMention?: boolean
  allowPrAuthor?: boolean
  allowAllActors?: boolean
  denyBots?: boolean
  allowedUsers: string[]
  allowedAuthorAssociations: string[]
  command?: string
  agent?: string
  model?: { providerId: string; modelId: string }
  variant?: string
}

export function selectGitHubWebhookPolicyDecision(
  rules: GitHubWebhookPolicyRule[] | undefined,
  input: { repoFullName: string; eventKey: string },
): GitHubWebhookPolicyDecision | null {
  const items = Array.isArray(rules) ? rules : []
  if (items.length === 0) return null

  for (const rule of items) {
    if (!rule || typeof rule !== "object") continue
    if (!matchesRule(rule, input)) continue

    const allow = rule.allow ?? {}
    return {
      ruleName: typeof rule.name === "string" ? rule.name : undefined,
      enabled: allow.enabled !== false,
      requireMention: allow.requireMention,
      allowPrAuthor: allow.allowPrAuthor,
      allowAllActors: allow.allowAllActors,
      denyBots: allow.denyBots,
      allowedUsers: normalizeList(allow.allowedUsers),
      allowedAuthorAssociations: normalizeList(allow.allowedAuthorAssociations).map((v) => v.toUpperCase()),
      command: typeof allow.command === "string" ? allow.command.trim() : undefined,
      agent: typeof allow.agent === "string" ? allow.agent.trim() : undefined,
      model:
        allow.model && typeof allow.model === "object" && typeof (allow.model as any).providerId === "string" && typeof (allow.model as any).modelId === "string"
          ? { providerId: (allow.model as any).providerId, modelId: (allow.model as any).modelId }
          : undefined,
      variant: typeof allow.variant === "string" ? allow.variant.trim() : undefined,
    }
  }

  return null
}

function matchesRule(rule: GitHubWebhookPolicyRule, input: { repoFullName: string; eventKey: string }): boolean {
  const match = rule.match ?? {}
  if (match.repo && !globMatch(String(match.repo), input.repoFullName)) return false
  if (match.repoRegex && !safeRegexMatch(String(match.repoRegex), input.repoFullName)) return false
  if (match.event && !globMatch(String(match.event), input.eventKey)) return false
  if (match.eventRegex && !safeRegexMatch(String(match.eventRegex), input.eventKey)) return false
  return true
}

function normalizeList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
}

function safeRegexMatch(source: string, value: string): boolean {
  try {
    return new RegExp(source).test(value)
  } catch {
    return false
  }
}

function globMatch(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value)
}

function globToRegExp(glob: string): RegExp {
  const raw = (glob ?? "").trim()
  if (!raw) return /^.*$/

  const escapeRegex = (s: string) => s.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&")
  let out = "^"
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch === "*") {
      if (raw[i + 1] === "*") {
        out += ".*"
        i += 1
      } else {
        out += "[^/\\.]*"
      }
      continue
    }
    if (ch === "?") {
      out += "[^/\\.]"
      continue
    }
    out += escapeRegex(ch)
  }
  out += "$"
  return new RegExp(out)
}
