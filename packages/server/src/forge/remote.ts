import { isIP } from "node:net"
import { runGitProcess } from "../workspaces/git-process"

export interface ForgeRemote {
  /** Lower-case web authority: the host name, with the port of an HTTPS remote on a non-default port. */
  host: string
  /** Repository path on the host, without `.git`: `owner/repo`, or `group/subgroup/project` on GitLab. */
  path: string
}

const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/

/**
 * Parses HTTPS, SSH (`ssh://`) and scp-like (`git@host:path`) remote URLs into
 * a strictly validated web authority and repository path, so neither can carry
 * URL delimiters into API or web addresses. An SSH port belongs to the SSH
 * transport, not the forge's web interface, so only HTTP(S) keeps its port.
 * Local paths, file URLs and anything without an owner and a name yield undefined.
 */
export function parseRemoteUrl(url: string): ForgeRemote | undefined {
  const trimmed = url.trim()
  let host: string | undefined
  let port = ""
  let rawPath: string | undefined
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed)
  if (/^(?:https?|ssh|git):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      host = parsed.hostname.toLowerCase()
      if (/^https?:$/i.test(parsed.protocol)) port = parsed.port
      rawPath = decodeURIComponent(parsed.pathname)
    } catch {
      return undefined
    }
  } else if (scp && !/^[a-z]$/i.test(scp[1]!)) {
    // A single letter before the colon is a Windows drive, not a host.
    host = scp[1]!.toLowerCase()
    rawPath = scp[2]
  }
  // A bracketed IPv6 literal is valid as such; it is never a public forge, so only a signed-in CLI reads it.
  const ipv6 = /^\[(.+)\]$/.exec(host ?? "")
  if (!host || !(ipv6 ? isIP(ipv6[1]!) === 6 : HOST_NAME.test(host)) || (port && !/^\d{1,5}$/.test(port)) || !rawPath) return undefined
  const path = rawPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
  const segments = path.split("/")
  if (segments.length < 2 || segments.some(segment => !PATH_SEGMENT.test(segment) || /^\.+$/.test(segment))) return undefined
  return { host: port ? `${host}:${port}` : host, path }
}

/**
 * The repository to contribute to: `upstream` when the checkout is a fork,
 * otherwise `origin`, otherwise the first remote with a forge URL.
 */
export async function readForgeRemote(directory: string): Promise<ForgeRemote | undefined> {
  const names = (await runGitProcess(directory, ["remote"], { priority: "foreground", timeout: 10_000 }).catch(() => ""))
    .split(/\r?\n/).map(name => name.trim()).filter(Boolean)
  const ordered = [...["upstream", "origin"].filter(name => names.includes(name)), ...names.filter(name => name !== "upstream" && name !== "origin")]
  for (const name of ordered) {
    const url = await runGitProcess(directory, ["remote", "get-url", name], { priority: "foreground", timeout: 10_000 }).catch(() => "")
    const remote = parseRemoteUrl(url)
    if (remote) return remote
  }
  return undefined
}
