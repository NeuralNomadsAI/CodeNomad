import type { RemoteServerProfile } from "../../../server/src/api-types"

export type LaunchConnectError = "missing" | "invalid" | "credentials" | "unknown" | "ambiguous"

export type LaunchConnectTarget =
  | { kind: "saved"; server: RemoteServerProfile }
  | { kind: "url"; baseUrl: string; name: string }
  | { kind: "error"; reason: LaunchConnectError }

function comparableUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`
  } catch {
    return undefined
  }
}

/**
 * Resolves a `--connect-server` value against the saved remote servers: a saved id, then a saved
 * name (exact, then case-insensitive), then an http(s) URL. A URL never carries credentials: user
 * info and fragments (where Remote Control pairing codes live) are refused.
 */
export function resolveLaunchConnectTarget(value: string, servers: readonly RemoteServerProfile[]): LaunchConnectTarget {
  const input = value.trim()
  if (!input) return { kind: "error", reason: "missing" }

  const byId = servers.find((server) => server.id === input)
  if (byId) return { kind: "saved", server: byId }

  const exact = servers.filter((server) => server.name.trim() === input)
  if (exact.length === 1) return { kind: "saved", server: exact[0]! }
  const folded = input.toLocaleLowerCase()
  const named = exact.length > 1 ? exact : servers.filter((server) => server.name.trim().toLocaleLowerCase() === folded)
  if (named.length === 1) return { kind: "saved", server: named[0]! }
  if (named.length > 1) return { kind: "error", reason: "ambiguous" }

  if (!input.includes("://")) return { kind: "error", reason: "unknown" }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { kind: "error", reason: "invalid" }
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return { kind: "error", reason: "invalid" }
  if (url.username || url.password || input.includes("#")) return { kind: "error", reason: "credentials" }

  const comparable = comparableUrl(url.href)
  const saved = servers.find((server) => comparableUrl(server.baseUrl) === comparable)
  if (saved) return { kind: "saved", server: saved }
  return { kind: "url", baseUrl: url.href, name: url.host }
}
