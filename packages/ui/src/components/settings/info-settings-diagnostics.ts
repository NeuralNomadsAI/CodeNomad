import type { NetworkAddress, ServerMeta } from "../../../../server/src/api-types"

export interface DiagnosticRuntime {
  host: string
  platform: string
  windowContext: string
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
  generatedAt = new Date(),
): string {
  const addresses = meta ? getDiagnosticAddresses(meta) : []
  const lines = [
    "CodeNomad Diagnostic Report",
    "============================",
    `Generated: ${generatedAt.toISOString()}`,
    `Server version: ${meta?.serverVersion ?? "unknown"}`,
    `UI version: ${meta?.ui?.version ?? "unknown"} (source: ${meta?.ui?.source ?? "unknown"})`,
    `Runtime: ${runtime.host}`,
    `Platform: ${runtime.platform}`,
    `Window context: ${runtime.windowContext}`,
    `OS: ${osDisplay}`,
    `Listening mode: ${meta ? getDiagnosticListeningMode(meta) : "unknown"}`,
    `Bind host: ${meta?.host ?? "unknown"}`,
    `Local URL: ${meta?.localUrl ?? "unknown"}`,
    `Local port: ${meta?.localPort ?? "unknown"}`,
    `Remote URL: ${meta?.remoteUrl ?? "none"}`,
    `Remote port: ${meta?.remotePort ?? "none"}`,
    `Workspace root: ${meta?.workspaceRoot ?? "unknown"}`,
    `Candidate addresses: ${addresses.length}`,
  ]

  for (const address of addresses) {
    lines.push(`- ${address.family}/${address.scope}: ${address.remoteUrl}`)
  }

  lines.push("")
  return lines.join("\n")
}
