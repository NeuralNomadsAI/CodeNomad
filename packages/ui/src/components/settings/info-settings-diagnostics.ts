import type { ServerMeta } from "../../../../server/src/api-types"

export interface DiagnosticRuntime {
  host: string
  platform: string
  windowContext: string
}

export function buildDiagnosticReport(
  meta: ServerMeta | null,
  osDisplay: string,
  runtime: DiagnosticRuntime,
  generatedAt = new Date(),
): string {
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
    `Listening mode: ${meta?.listeningMode ?? "unknown"}`,
    `Bind host: ${meta?.host ?? "unknown"}`,
    `Local URL: ${meta?.localUrl ?? "unknown"}`,
    `Local port: ${meta?.localPort ?? "unknown"}`,
    `Remote URL: ${meta?.remoteUrl ?? "none"}`,
    `Remote port: ${meta?.remotePort ?? "none"}`,
    `Workspace root: ${meta?.workspaceRoot ?? "unknown"}`,
    `Candidate addresses: ${meta?.addresses.length ?? 0}`,
  ]

  for (const address of meta?.addresses ?? []) {
    lines.push(`- ${address.family}/${address.scope}: ${address.remoteUrl}`)
  }

  lines.push("")
  return lines.join("\n")
}
