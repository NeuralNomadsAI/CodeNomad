import type { IntegrationBindingResponse, IntegrationView } from "../../../server/src/integration-types"

type Entry = Pick<IntegrationView, "family" | "state" | "status">

/** The displayed conversation's attachment, shown by a native integration's Plugins row. */
export type IntegrationLink = IntegrationBindingResponse

/** A Plugins row's indicator: shown only when the application part needs an action. */
export type IntegrationAttention = "hostAbsent" | "hostOutdated" | "incompatible"

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

export function integrationAttention(entry: Entry): IntegrationAttention | undefined {
  if (!loadedNative(entry)) return undefined
  const host = entry.status?.host?.state
  return host === "absent" ? "hostAbsent" : host === "outdated" ? "hostOutdated" : host === "incompatible" ? "incompatible" : undefined
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

/** The catalogue summary in the current language, else English. */
export function integrationSummary(entry: Pick<IntegrationView, "summary">, locale: string): string {
  return entry.summary[locale] ?? entry.summary[locale.split("-")[0]!] ?? entry.summary.en ?? Object.values(entry.summary)[0] ?? ""
}
