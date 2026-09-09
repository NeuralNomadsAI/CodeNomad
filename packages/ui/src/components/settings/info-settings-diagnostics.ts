import type { NetworkAddress, ServerMeta } from "../../../../server/src/api-types"

export interface DiagnosticRuntime {
  host: string
  platform: string
  windowContext: string
}

export interface DiagnosticLabels {
  reportTitle: string
  generated: string
  serverVersion: string
  uiVersion: string
  uiSource: string
  runtime: string
  platform: string
  windowContext: string
  os: string
  listeningMode: string
  bindHost: string
  localListener: string
  remoteListener: string
  workspaceRoot: string
  candidateAddresses: string
  modes: Record<DiagnosticListeningMode, string>
  scopes: Record<NetworkAddress["scope"], string>
}

export type DiagnosticListeningMode = ServerMeta["listeningMode"] | "specific"

export function getDiagnosticListeningMode(meta: ServerMeta): DiagnosticListeningMode {
  if (isWildcardBindHost(meta.host)) return "all"
  if (meta.listeningMode === "all") return "specific"
  return meta.listeningMode
}

export function getDiagnosticAddresses(meta: ServerMeta): NetworkAddress[] {
  if (isWildcardBindHost(meta.host)) return meta.addresses
  const host = normalizeBindHost(meta.host)
  return meta.addresses.filter((address) => normalizeBindHost(address.ip) === host)
}

function isWildcardBindHost(host: string): boolean {
  const value = normalizeBindHost(host)
  if (value === "0.0.0.0") return true
  return value.includes(":") && value.split(":").every((segment) => segment === "" || /^0+$/.test(segment))
}

function normalizeBindHost(host: string): string {
  const value = host.trim().toLowerCase()
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value
}

export function buildDiagnosticReport(
  meta: ServerMeta | null,
  osDisplay: string,
  runtime: DiagnosticRuntime,
  labels: DiagnosticLabels,
  generatedAt = new Date(),
): string {
  const addresses = meta ? getDiagnosticAddresses(meta) : []
  const listeningMode = meta ? labels.modes[getDiagnosticListeningMode(meta)] : "—"
  const lines = [
    labels.reportTitle,
    "============================",
    `${labels.generated}: ${generatedAt.toISOString()}`,
    `${labels.serverVersion}: ${meta?.serverVersion ?? "—"}`,
    `${labels.uiVersion}: ${meta?.ui?.version ?? "—"}`,
    `${labels.uiSource}: ${meta?.ui?.source ?? "—"}`,
    `${labels.runtime}: ${runtime.host}`,
    `${labels.platform}: ${runtime.platform}`,
    `${labels.windowContext}: ${runtime.windowContext}`,
    `${labels.os}: ${osDisplay}`,
    `${labels.listeningMode}: ${listeningMode}`,
    `${labels.bindHost}: ${meta?.host ?? "—"}`,
    `${labels.localListener}: ${meta?.localUrl ?? "—"}`,
    `${labels.remoteListener}: ${meta?.remoteUrl ?? "—"}`,
    `${labels.workspaceRoot}: ${meta?.workspaceRoot ?? "—"}`,
    `${labels.candidateAddresses}: ${addresses.length}`,
  ]

  for (const address of addresses) {
    lines.push(`- ${address.family}/${labels.scopes[address.scope]}: ${address.remoteUrl}`)
  }

  lines.push("")
  return lines.join("\n")
}
