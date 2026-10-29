import { runGitProcess } from "../workspaces/git-process"

export interface ForgeRemote {
  /** Lower-case host name, without user, port or path. */
  host: string
  /** Repository path on the host, without `.git`: `owner/repo`, or `group/subgroup/project` on GitLab. */
  path: string
}

/**
 * Parses HTTPS, SSH (`ssh://`) and scp-like (`git@host:path`) remote URLs.
 * Local paths, file URLs and anything without an owner and a name yield undefined.
 */
export function parseRemoteUrl(url: string): ForgeRemote | undefined {
  const trimmed = url.trim()
  let host: string | undefined
  let rawPath: string | undefined
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed)
  if (/^(?:https?|ssh|git):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      host = parsed.hostname
      rawPath = decodeURIComponent(parsed.pathname)
    } catch {
      return undefined
    }
  } else if (scp && !/^[a-z]$/i.test(scp[1]!)) {
    // A single letter before the colon is a Windows drive, not a host.
    host = scp[1]
    rawPath = scp[2]
  }
  if (!host || !rawPath) return undefined
  const path = rawPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
  const segments = path.split("/")
  if (segments.length < 2 || segments.some(segment => !segment || segment === "." || segment === "..")) return undefined
  return { host: host.toLowerCase(), path }
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
