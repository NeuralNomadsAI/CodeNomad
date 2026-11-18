import { isIP } from "node:net"
import { runGitProcess } from "../workspaces/git-process"

export interface ForgeRemote {
  /** Lower-case authority. Forge parsing keeps web ports; repository parsing keeps transport ports. */
  host: string
  /** Repository path on the host, without `.git`; forge parsing requires an owner/group and name. */
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
  return parseGitRemoteUrl(url, false)
}

/** Repository identity retains transport ports and canonical URL-encoded path segments. */
export function parseRepositoryRemoteUrl(url: string): ForgeRemote | undefined {
  return parseGitRemoteUrl(url, true)
}

function parseGitRemoteUrl(url: string, forIdentity: boolean): ForgeRemote | undefined {
  const trimmed = url.trim()
  let host: string | undefined
  let port = ""
  let rawPath: string | undefined
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed)
  if (/^(?:https?|ssh|git):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      host = parsed.hostname.toLowerCase()
      if (forIdentity) {
        // URL.port drops explicit default HTTP ports; identity retains the written authority.
        const explicit = /:(\d+)$/.exec(trimmed.split("/")[2]?.split("@").at(-1) ?? "")?.[1]
        port = explicit ? String(Number(explicit)) : ""
      } else if (/^https?:$/i.test(parsed.protocol)) port = parsed.port
      rawPath = forIdentity ? parsed.pathname : decodeURIComponent(parsed.pathname)
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
  try {
    const segments = rawPath.replace(/^\/+|\/+$/g, "").split("/").map(segment => forIdentity ? decodeURIComponent(segment) : segment)
    segments[segments.length - 1] = segments.at(-1)!.replace(/\.git$/i, "")
    if (segments.length < (forIdentity ? 1 : 2) || segments.some(segment => !segment || /^\.+$/.test(segment)
      || (forIdentity ? /[\x00-\x1f\x7f/\\]/.test(segment) : !PATH_SEGMENT.test(segment)))) return undefined
    return { host: port ? `${host}:${port}` : host, path: segments.map(segment => forIdentity ? encodeURIComponent(segment) : segment).join("/") }
  } catch { return undefined }
}

/**
 * The repository to contribute to: `upstream` when the checkout is a fork,
 * otherwise `origin`, otherwise the first remote with a forge URL.
 */
export async function readForgeRemote(directory: string, signal?: AbortSignal): Promise<ForgeRemote | undefined> {
  const expires = performance.now() + 10_000
  const cleared = Object.fromEntries(Object.keys(process.env).filter(key => key.toUpperCase().startsWith("GIT_")).map(key => [key, undefined]))
  const read = async (args: string[]) => {
    signal?.throwIfAborted()
    const timeout = Math.floor(expires - performance.now())
    if (timeout <= 0) throw new Error("Forge remote discovery timeout")
    const output = await runGitProcess(directory, args, { priority: "foreground", timeout,
      env: { ...cleared, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } }).catch(() => "")
    signal?.throwIfAborted()
    if (performance.now() >= expires) throw new Error("Forge remote discovery timeout")
    return output
  }
  const names = (await read(["remote"]))
    .split(/\r?\n/).map(name => name.trim()).filter(Boolean)
  const ordered = [...["upstream", "origin"].filter(name => names.includes(name)), ...names.filter(name => name !== "upstream" && name !== "origin")]
  for (const name of ordered) {
    const url = await read(["remote", "get-url", name])
    const remote = parseRemoteUrl(url)
    if (remote) return remote
  }
  return undefined
}
