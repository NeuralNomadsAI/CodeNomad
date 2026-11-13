import type { MessageInfo } from "../types/message"
import { agents, providers } from "../stores/session-state"

/**
 * Resolves the agent label for an assistant message the way the composer footer
 * does, falling back to the raw mode identifier when the agent is unknown.
 *
 * @param instanceId - Instance whose agent registry holds the display name.
 * @param info - Message info; empty for non-assistant messages.
 * @returns The agent display name, or "" when unavailable.
 */
export function assistantAgentIdentifier(instanceId: string, info?: MessageInfo): string {
  if (!info || info.role !== "assistant") return ""
  return agents().get(instanceId)?.find((agent) => agent.id === info.mode)?.name || info.mode || ""
}

/**
 * Resolves the model label for an assistant message: the provider's display
 * name when known, otherwise `providerID/modelID`, with a non-empty variant
 * appended as `base • variant`.
 *
 * @param instanceId - Instance whose provider registry holds the model name.
 * @param info - Message info; empty for non-assistant messages.
 * @returns The model label, or "" when neither provider nor model id exists.
 */
export function assistantModelIdentifier(instanceId: string, info?: MessageInfo): string {
  if (!info || info.role !== "assistant") return ""
  const modelID = info.modelID || ""
  const providerID = info.providerID || ""

  const name = providers().get(instanceId)?.find((provider) => provider.id === providerID)?.models.find((model) => model.id === modelID)?.name
  const base = name || (modelID && providerID ? `${providerID}/${modelID}` : modelID)
  if (!base) return ""

  const variant = info.variant
  if (typeof variant === "string" && variant.trim().length > 0) {
    return `${base} • ${variant.trim()}`
  }

  return base
}

/**
 * The `agent • model` meta string an assistant message header shows, reused by
 * rows that carry the meta instead of the header (e.g. reasoning-first messages).
 *
 * @param instanceId - Instance whose registries resolve the labels.
 * @param info - Message info of the assistant message.
 * @returns The joined meta string, or "" when both halves are unavailable.
 */
export function assistantAgentMeta(instanceId: string, info?: MessageInfo): string {
  const segments: string[] = []
  const agent = assistantAgentIdentifier(instanceId, info)
  const model = assistantModelIdentifier(instanceId, info)
  if (agent) segments.push(agent)
  if (model) segments.push(model)
  return segments.join(" • ")
}
