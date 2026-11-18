import type { IntegrationBindingResponse, IntegrationHostOffer, IntegrationView } from "../../../server/src/integration-types"

type Entry = Pick<IntegrationView, "family" | "state" | "status">

/** The displayed conversation's attachment, shown by a native integration's Plugins row. */
export type IntegrationLink = IntegrationBindingResponse

/** The connection state of the row menu's information line. */
export type IntegrationConnection =
  | { state: "offers"; count: number }
  | { state: "noOffer" | "hostClosed" | "unsupported" | "detected" | "absent" | "connected" | "disconnected" | "unknown" }

const loadedNative = (entry: Entry) => entry.family === "native" && entry.state === "ok"

/**
 * The link state of a loaded native integration for the displayed conversation: none without a conversation,
 * else the integration's own per-conversation read. Other families and unloaded integrations have no link.
 */
export function integrationLink(entry: Entry, binding: IntegrationBindingResponse | undefined): IntegrationLink | undefined {
  if (!loadedNative(entry) || entry.status?.host?.state === "unsupported") return undefined
  return binding ?? { state: "none" }
}

export function integrationConnection(entry: Entry): IntegrationConnection {
  if (entry.state !== "ok") return { state: "unknown" }
  const connection = entry.status?.connection
  if (entry.family === "native") {
    const host = entry.status?.host?.state
    if (host === "unsupported") return { state: "unsupported" }
    const offers = connection?.offers ?? 0
    if (offers > 0) return { state: "offers", count: offers }
    return { state: host === "unknown" ? "hostClosed" : "noOffer" }
  }
  if (entry.family === "vendor-mcp") return { state: connection?.state === "connected" ? "detected" : "absent" }
  return { state: connection?.state === "connected" ? "connected" : "disconnected" }
}

/** The i18n key and variables of a connection line. */
export function integrationConnectionMessage(connection: IntegrationConnection, app: string): [string, Record<string, string | number>] {
  if (connection.state === "offers") return [`integrations.connection.offers.${connection.count === 1 ? "one" : "other"}`, { app, count: connection.count }]
  return [`integrations.connection.${connection.state}`, { app }]
}

/** After reading the open documents: attach the only compatible one, choose between several, or none. */
export type IntegrationAttachChoice = { kind: "attach"; offerID: string } | { kind: "choose"; offers: IntegrationHostOffer[] } | { kind: "none" }

export function integrationAttachChoice(offers: readonly IntegrationHostOffer[]): IntegrationAttachChoice {
  const compatible = offers.filter(offer => offer.protocol === "ok")
  if (compatible.length === 0) return { kind: "none" }
  return compatible.length === 1 ? { kind: "attach", offerID: compatible[0]!.offerID } : { kind: "choose", offers: compatible }
}

/**
 * The state line under an integration's name: one state, the most important, with the action it offers. `info` is
 * muted text, `action` the accent and clickable, `warning` the warning colour.
 */
export interface IntegrationStateLine {
  key: string
  vars?: Record<string, string>
  tone: "info" | "action" | "warning"
  action?: "install" | "update" | "attach" | "detach"
  /** For `attach`: the only compatible document shown, attached directly when it is still the only one. */
  offerID?: string
}

export interface IntegrationStateLineInput {
  entry: Pick<IntegrationView, "family" | "state" | "status" | "app">
  /** The displayed conversation's binding, for a loaded native integration. */
  link?: IntegrationLink
  /** The open documents as last read, undefined until read. */
  offers?: readonly IntegrationHostOffer[]
  /** A conversation of this Location is displayed. */
  conversation: boolean
  /** The application part's installation can be requested now. */
  canInstall: boolean
}

const documentName = (offer: Pick<IntegrationHostOffer, "document" | "label">) => offer.document ?? offer.label

export function integrationStateLine(input: IntegrationStateLineInput): IntegrationStateLine {
  const { entry } = input
  const app = entry.app.name
  if (entry.state !== "ok") {
    const key = entry.state === "inactive" ? "integrations.line.inactive" : entry.state === "failed" ? "integrations.line.failed"
      : entry.state === "non-conforming" ? "integrations.state.nonConforming" : entry.state === "unsupported" ? "integrations.line.unsupported"
        : "integrations.line.unknown"
    return { key, tone: entry.state === "failed" || entry.state === "non-conforming" ? "warning" : "info" }
  }
  if (entry.family === "vendor-mcp") return { key: `integrations.connection.${integrationConnection(entry).state}`, tone: "info" }
  if (entry.family === "api") return { key: `integrations.connection.${integrationConnection(entry).state}`, tone: "info" }
  const host = entry.status?.host?.state
  if (host === "unsupported") return { key: "integrations.line.unsupported", tone: "info" }
  if (host === "absent") return input.canInstall ? { key: "integrations.line.install", vars: { app }, tone: "action", action: "install" }
    : { key: "integrations.attention.hostAbsent", vars: { app }, tone: "info" }
  if (host === "outdated") return input.canInstall ? { key: "integrations.line.update", vars: { app }, tone: "action", action: "update" }
    : { key: "integrations.attention.hostOutdated", vars: { app }, tone: "info" }
  if (host === "incompatible") return { key: "integrations.attention.incompatible", vars: { app }, tone: "warning" }
  if (input.link?.state === "attached") {
    const label = input.link.label
    const offer = input.offers?.find(item => item.label === label)
    return { key: "integrations.line.attached", vars: { document: offer ? documentName(offer) : label }, tone: "action", action: "detach" }
  }
  if (host === "unknown") return { key: "integrations.connection.hostClosed", vars: { app }, tone: "info" }
  if ((entry.status?.connection?.offers ?? 0) === 0) return { key: "integrations.connection.noOffer", vars: { app }, tone: "info" }
  if (!input.conversation) return { key: "integrations.link.noConversation", tone: "info" }
  const compatible = input.offers?.filter(offer => offer.protocol === "ok")
  if (compatible?.length === 0) return { key: "integrations.connection.noOffer", vars: { app }, tone: "info" }
  if (compatible?.length === 1) {
    return { key: "integrations.line.attachOne", vars: { document: documentName(compatible[0]!) }, tone: "action", action: "attach", offerID: compatible[0]!.offerID }
  }
  return { key: "integrations.line.attachMany", tone: "action", action: "attach" }
}

/** The catalogue summary in the current language, else English. */
export function integrationSummary(entry: Pick<IntegrationView, "summary">, locale: string): string {
  return entry.summary[locale] ?? entry.summary[locale.split("-")[0]!] ?? entry.summary.en ?? Object.values(entry.summary)[0] ?? ""
}
