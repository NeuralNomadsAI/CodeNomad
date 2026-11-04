import type { IntegrationBindingResponse, IntegrationView } from "../../../server/src/integration-types"
import type { IntegrationInstallState } from "../stores/plugin-sources"

/** The section's state label (spec change §5.2), highest precedence first. */
export type IntegrationSectionLabel =
  | "uncertain" | "installing" | "failed" | "disabled" | "unconfirmed" | "nonConforming" | "unsupported" | "unknown"
  | "hostAbsent" | "incompatible" | "hostOutdated" | "hostClosed" | "legacy" | "attached" | "available" | "ready"

/** The Conversation line (spec change §5.1), for the displayed conversation only. */
export type IntegrationConversationRow =
  | { state: "unsupported" }
  | { state: "noConversation" }
  | { state: "uncertain" }
  | { state: "attached"; label: string }
  | { state: "unknown" }
  | { state: "reattach"; label: string }
  | { state: "available" }
  | { state: "noOffer" }

export type IntegrationApplicationState = "ok" | "absent" | "outdated" | "incompatible" | "unknown" | "unsupported"
export type IntegrationConnectionState = "detected" | "absent" | "connected" | "disconnected"

export interface IntegrationSectionInput {
  entry: Pick<IntegrationView, "id" | "family" | "state" | "outdated" | "status">
  /** The install hint of this Location (`PluginSourcesStore.installation`). */
  installation?: IntegrationInstallState
  /** An effective `-id` rule disables its plugin. */
  disabled: boolean
  conversation: {
    /** A conversation of this Location is displayed. */
    present: boolean
    /** The authoritative binding read of the displayed conversation. */
    binding: IntegrationBindingResponse
    /** A submitted action whose effect was not read again yet. */
    uncertain: boolean
    /** A validated saved hint matched to a fresh offer of this integration. */
    hint?: string
  }
}

export interface IntegrationSectionState {
  label: IntegrationSectionLabel
  /** `outdated` plugin, shown beside the label (cumulative). */
  updateAvailable: boolean
  /** The label asks for an action: such a section is expanded. */
  expectsAction: boolean
  application?: { state: IntegrationApplicationState; action?: "install" | "update" }
  conversation?: IntegrationConversationRow
  connection?: IntegrationConnectionState
}

const EXPECTED_ACTIONS: ReadonlySet<IntegrationSectionLabel> = new Set(["hostAbsent", "hostOutdated", "incompatible", "unconfirmed", "failed"])

export function deriveIntegrationSectionState(input: IntegrationSectionInput): IntegrationSectionState {
  const { entry } = input
  const ok = entry.state === "ok"
  const host = ok && entry.family === "native" ? entry.status?.host : undefined
  const application = host ? { state: host.state, ...(host.action ? { action: host.action } : {}) } : undefined
  const conversation = ok && entry.family === "native" ? conversationRow(input) : undefined
  const connection = ok ? connectionState(entry) : undefined
  const label = sectionLabel(input, conversation)
  return {
    label,
    updateAvailable: entry.outdated === true,
    expectsAction: EXPECTED_ACTIONS.has(label),
    ...(application ? { application } : {}),
    ...(conversation ? { conversation } : {}),
    ...(connection ? { connection } : {}),
  }
}

/** Expands a section once per key: an expected action, or the displayed conversation attached. */
export function integrationAutoExpandKey(state: IntegrationSectionState): string | undefined {
  return state.expectsAction ? state.label : state.conversation?.state === "attached" ? "attached" : undefined
}

function sectionLabel(input: IntegrationSectionInput, conversation: IntegrationConversationRow | undefined): IntegrationSectionLabel {
  const { entry } = input
  if (input.conversation.uncertain) return "uncertain"
  if (input.installation === "pending") return "installing"
  if (entry.state === "failed" || input.installation === "failed") return "failed"
  if (input.disabled) return "disabled"
  if (entry.state === "inactive" || entry.state === "absent") return "unconfirmed"
  if (entry.state === "non-conforming") return "nonConforming"
  if (entry.state === "unsupported") return "unsupported"
  if (entry.state !== "ok") return "unknown"
  if (entry.family === "native") {
    const host = entry.status?.host?.state
    if (host === "unsupported") return "unsupported"
    if (host === "absent") return "hostAbsent"
    if (host === "incompatible") return "incompatible"
    if (host === "outdated") return "hostOutdated"
    if (host === "unknown") return "hostClosed"
  }
  if (entry.status?.notices?.includes("legacy_install")) return "legacy"
  if (conversation?.state === "attached") return "attached"
  if ((entry.status?.connection?.offers ?? 0) > 0) return "available"
  return "ready"
}

function conversationRow(input: IntegrationSectionInput): IntegrationConversationRow {
  const { entry, conversation } = input
  if (entry.status?.host?.state === "unsupported") return { state: "unsupported" }
  if (!conversation.present) return { state: "noConversation" }
  if (conversation.uncertain) return { state: "uncertain" }
  // Only the authoritative read attaches; a hint or a receipt never does.
  if (conversation.binding.state === "attached") return { state: "attached", label: conversation.binding.label }
  if (conversation.binding.state === "unknown") return { state: "unknown" }
  if ((entry.status?.connection?.offers ?? 0) === 0) return { state: "noOffer" }
  return conversation.hint ? { state: "reattach", label: conversation.hint } : { state: "available" }
}

function connectionState(entry: IntegrationSectionInput["entry"]): IntegrationConnectionState | undefined {
  const state = entry.status?.connection?.state
  if (entry.family === "vendor-mcp") return state === "connected" ? "detected" : "absent"
  if (entry.family === "api") return state === "connected" ? "connected" : "disconnected"
  return undefined
}
