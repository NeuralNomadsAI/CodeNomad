import type { NetworkAddress, ServerMeta } from "../../../../server/src/api-types"
import type { BugReportEnvironment } from "../../lib/bug-report"

export interface DiagnosticRuntime {
  host: string
  platform: string
  windowContext: string
}

export interface DiagnosticLabels {
  reportTitle: string
  generated: string
  serverVersion: string
  serverOs: string
  serverArch: string
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

export function getServerOperatingSystem(meta: ServerMeta | null): string {
  switch (meta?.system?.platform) {
    case "win32": return "Windows"
    case "darwin": return "macOS"
    case "linux": return "Linux"
    default: return meta?.system?.platform || "—"
  }
}

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

export interface BugReportVersions {
  opencodeInstalled?: string | null
  opencodeDaemon?: string | null
  userAgent?: string
}

/** Environment values for the issue form, in the form's own (English) terms.
 * Never includes listeners, addresses, paths, credentials or conversation data. */
export function buildBugReportEnvironment(
  meta: ServerMeta | null,
  osDisplay: string,
  runtime: DiagnosticRuntime,
  versions: BugReportVersions,
): BugReportEnvironment {
  const server = meta?.serverVersion
  const ui = meta?.ui?.version
  const codenomadVersion = server && ui && ui !== server ? `${server} (UI ${ui})` : server ?? ui ?? ""
  const { opencodeInstalled: installed, opencodeDaemon: daemon } = versions
  const opencodeVersion = daemon && installed && daemon !== installed
    ? `${installed} (running daemon ${daemon})`
    : daemon ?? installed ?? ""
  const variant = runtime.host === "electron" ? "Electron" : runtime.host === "tauri" ? "Tauri" : "Web browser"
  const context = [
    `- Client: ${variant} (${runtime.platform}, ${runtime.windowContext} window)`,
    `- UI source: ${meta?.ui?.source ?? "—"}`,
    `- Server OS: ${getServerOperatingSystem(meta)} ${meta?.system?.arch ?? ""}`.trimEnd(),
  ]
  if (runtime.host === "web" && versions.userAgent) context.push(`- Browser: ${versions.userAgent}`)
  return { codenomadVersion, opencodeVersion, operatingSystem: osDisplay, additionalContext: context.join("\n") }
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
    `${labels.serverOs}: ${getServerOperatingSystem(meta)}`,
    `${labels.serverArch}: ${meta?.system?.arch ?? "—"}`,
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
