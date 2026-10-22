import { agents, providers } from "../stores/session-state"
import type { MessageInfo } from "../types/message"

export interface MessageProfileLabel {
  /** Agent and model names as the composer footer shows them, then the thinking variant. */
  text: string
  /** The native identifiers behind them, for tooltips and diagnosis. */
  exact: string
}

const EMPTY: MessageProfileLabel = { text: "", exact: "" }
const join = (segments: string[]) => segments.filter(Boolean).join(" • ")

/** Names an assistant message's agent, model and variant from the instance catalogs; unknown entries keep their identifiers. */
export function messageProfileLabel(instanceId: string, info: MessageInfo | undefined): MessageProfileLabel {
  if (!info || info.role !== "assistant") return EMPTY
  const agentId = info.mode || ""
  const providerId = info.providerID || ""
  const modelId = info.modelID || ""
  const variant = typeof info.variant === "string" ? info.variant.trim() : ""
  const modelKey = modelId && providerId ? `${providerId}/${modelId}` : modelId

  const agentName = agentId ? agents().get(instanceId)?.find((agent) => agent.id === agentId)?.name || agentId : ""
  const modelName = modelId
    ? providers().get(instanceId)?.find((provider) => provider.id === providerId)?.models.find((model) => model.id === modelId)?.name || modelKey
    : ""

  return { text: join([agentName, modelName, variant]), exact: join([agentId, modelKey, variant]) }
}
