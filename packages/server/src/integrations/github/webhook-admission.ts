export type GitHubActor = {
  login?: string
  authorAssociation?: string
  type?: string
}

export type GitHubAdmissionPolicy = {
  allowedUsers: string[]
  allowedAuthorAssociations: string[]
  allowAllActors?: boolean
  denyBots?: boolean
}

export function isGitHubActorAllowed(policy: GitHubAdmissionPolicy, actor: GitHubActor): boolean {
  if (policy.denyBots) {
    const kind = (actor.type ?? "").trim().toLowerCase()
    if (kind === "bot") return false
  }

  if (policy.allowAllActors) return true

  const login = (actor.login ?? "").trim().toLowerCase()
  const allowedUsers = (policy.allowedUsers ?? []).map((u) => u.trim().toLowerCase()).filter(Boolean)
  if (login && allowedUsers.includes(login)) return true

  const association = (actor.authorAssociation ?? "").trim().toUpperCase()
  if (!association) return false
  const configured = (policy.allowedAuthorAssociations ?? []).map((v) => v.trim().toUpperCase()).filter(Boolean)
  const fallback = configured.length > 0 ? configured : ["OWNER", "COLLABORATOR"]
  return new Set(fallback).has(association)
}

export function hasGitHubMentionTrigger(params: {
  text: string
  mentionHandle?: string
  botLogin?: string
}): boolean {
  const text = (params.text ?? "").trim()
  if (!text) return false

  const handles: string[] = []
  const configured = (params.mentionHandle ?? "").trim()
  if (configured) handles.push(configured)

  const botLogin = (params.botLogin ?? "").trim()
  if (botLogin) {
    handles.push(botLogin.replace(/\[bot\]$/i, ""))
    handles.push(botLogin)
  }

  if (handles.length === 0) handles.push("codenomad")

  const unique = Array.from(new Set(handles.map((h) => h.trim()).filter(Boolean)))
  for (const handle of unique) {
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`(^|\\s)@${escaped}(\\b|\\s|$)`, "i")
    if (re.test(text)) return true
  }
  return false
}
