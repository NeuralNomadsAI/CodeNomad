import { fetch } from "undici"
import type { LatestReleaseInfo } from "../api-types"
import type { Logger } from "../logger"
import { compareVersionStrings, stripTagPrefix } from "./release-monitor"

interface DevReleaseMonitorOptions {
  /** Current running server version (from package.json). */
  currentVersion: string
  /** GitHub repo in the form "owner/name". */
  repo: string
  logger: Logger
  onUpdate: (release: LatestReleaseInfo | null) => void
  pollIntervalMs?: number
}

interface GithubReleaseListItem {
  tag_name?: string
  name?: string
  html_url?: string
  body?: string
  published_at?: string
  created_at?: string
  prerelease?: boolean
  draft?: boolean
}

export interface DevReleaseMonitor {
  stop(): void
}

const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000

export function startDevReleaseMonitor(options: DevReleaseMonitorOptions): DevReleaseMonitor {
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const pollIntervalMs =
    Number.isFinite(options.pollIntervalMs) && (options.pollIntervalMs ?? 0) > 0
      ? (options.pollIntervalMs as number)
      : DEFAULT_POLL_INTERVAL_MS

  const refresh = async () => {
    if (stopped) return
    try {
      const release = await fetchLatestPrerelease({
        repo: options.repo,
        currentVersion: options.currentVersion,
      })
      options.onUpdate(release)
    } catch (error) {
      options.logger.debug({ err: error }, "Failed to refresh dev prerelease information")
    }
  }

  void refresh()
  timer = setInterval(() => void refresh(), pollIntervalMs)

  return {
    stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

async function fetchLatestPrerelease(args: {
  repo: string
  currentVersion: string
}): Promise<LatestReleaseInfo | null> {
  const normalizedRepo = args.repo.trim()
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalizedRepo)) {
    throw new Error(`Invalid GitHub repo: ${args.repo}`)
  }

  const apiUrl = `https://api.github.com/repos/${normalizedRepo}/releases?per_page=20`
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "CodeNomad-CLI",
    },
  })

  if (!response.ok) {
    throw new Error(`GitHub releases API responded with ${response.status}`)
  }

  const list = (await response.json()) as GithubReleaseListItem[]
  const latest = list.find((r) => r && r.prerelease === true && r.draft !== true)
  if (!latest) {
    return null
  }

  const tag = latest.tag_name || latest.name
  if (!tag) {
    return null
  }

  const normalizedVersion = stripTagPrefix(tag)
  if (!normalizedVersion) {
    return null
  }

  if (compareVersionStrings(normalizedVersion, args.currentVersion) <= 0) {
    return null
  }

  return {
    version: normalizedVersion,
    tag,
    url: latest.html_url ?? `https://github.com/${normalizedRepo}/releases/tag/${encodeURIComponent(tag)}`,
    channel: "dev",
    publishedAt: latest.published_at ?? latest.created_at,
    notes: latest.body,
  }
}
