import { DESIGN_AGENT_ID } from "./content"

export type DesignAgentStatus =
  | { designAgent: "absent" | "user"; contentVersion: null }
  | { designAgent: "present"; contentVersion: number }

const MARK = /^codenomad-design-content: ([1-9]\d{0,5})(?:\r?\n|$)/

/**
 * Classifies a Location's `GET /api/agent` list: no `design` agent, CodeNomad's
 * (its system prompt starts with the content mark), or the user's own.
 */
export function designAgentStatus(agents: readonly unknown[]): DesignAgentStatus {
  const agent = agents.find((entry): entry is { system?: unknown } =>
    Boolean(entry) && typeof entry === "object" && (entry as { id?: unknown }).id === DESIGN_AGENT_ID)
  if (!agent) return { designAgent: "absent", contentVersion: null }
  const mark = typeof agent.system === "string" ? MARK.exec(agent.system) : null
  return mark ? { designAgent: "present", contentVersion: Number(mark[1]) } : { designAgent: "user", contentVersion: null }
}
