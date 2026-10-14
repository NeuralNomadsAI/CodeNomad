import { fetch } from "undici"
import type { LatestReleaseInfo, UpdateFeed } from "../api-types"
import type { Logger } from "../logger"
import { compareVersionStrings, stripTagPrefix } from "./release-monitor"

interface PreviewReleaseMonitorOptions {
  /** Current running server version (from package.json). */
  currentVersion: string
  /** GitHub repo in the form "owner/name". */
  repo: string
  logger: Logger
  /** Read on every refresh; only the preview feed polls GitHub. */
  feed: () => UpdateFeed
  onUpdate: (release: LatestReleaseInfo | null) => void
  pollIntervalMs?: number
}

export interface GithubReleaseListItem {
  tag_name?: string
  name?: string
  html_url?: string
  body?: string
  published_at?: string
  created_at?: string
  prerelease?: boolean
  draft?: boolean
}

export interface PreviewReleaseMonitor {
  refresh(): void
  stop(): void
}

const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000

/** The update feed only selects which releases are offered. An explicit saved
 * choice wins; otherwise the installed build's label picks the initial feed. */
export function resolveUpdateFeed(configured: unknown, currentVersion: string): UpdateFeed {
  if (configured === "stable" || configured === "preview") return configured
  return /-dev[.-]/i.test(currentVersion) ? "preview" : "stable"
}

const tagOf = (release: GithubReleaseListItem) => release.tag_name || release.name || ""
const publishedOf = (release: GithubReleaseListItem) => Date.parse(release.published_at ?? release.created_at ?? "") || 0

/** Preview builds reuse the last stable version plus a `-dev-*` (or legacy
 * `-dev-v2-*`) label, so SemVer alone ranks newer previews below their base
 * release. Offer the newest published release of any kind, newer by
 * publication than the installed release when it is known. The installed
 * release may be older than the fetched page; `lookupInstalled` then fetches
 * it by tag. Only builds GitHub does not know fall back to version order. */
export async function findPreviewRelease(
  list: GithubReleaseListItem[],
  currentVersion: string,
  lookupInstalled: (tag: string) => Promise<GithubReleaseListItem | null> = async () => null,
): Promise<GithubReleaseListItem | null> {
  const releases = list.filter((release) => release && release.draft !== true && stripTagPrefix(tagOf(release)))
  const latest = releases.reduce<GithubReleaseListItem | null>((best, release) =>
    !best || publishedOf(release) > publishedOf(best) ? release : best, null)
  if (!latest) return null
  const current = stripTagPrefix(currentVersion)
  const latestVersion = stripTagPrefix(tagOf(latest))
  if (!current || latestVersion === current) return null
  let installed = releases.find((release) => stripTagPrefix(tagOf(release)) === current) ?? null
  if (!installed) {
    const found = await lookupInstalled(`v${current}`).catch(() => null)
    installed = found && found.draft !== true && stripTagPrefix(tagOf(found)) === current && publishedOf(found) ? found : null
  }
  if (installed) return publishedOf(latest) > publishedOf(installed) ? latest : null
  return compareVersionStrings(latestVersion!, currentVersion) > 0 ? latest : null
}

export function startPreviewReleaseMonitor(options: PreviewReleaseMonitorOptions): PreviewReleaseMonitor {
  let stopped = false
  let generation = 0

  const pollIntervalMs =
    Number.isFinite(options.pollIntervalMs) && (options.pollIntervalMs ?? 0) > 0
      ? (options.pollIntervalMs as number)
      : DEFAULT_POLL_INTERVAL_MS

  const refresh = async () => {
    if (stopped) return
    const current = ++generation
    if (options.feed() !== "preview") {
      options.onUpdate(null)
      return
    }
    try {
      const release = await fetchLatestPreview({
        repo: options.repo,
        currentVersion: options.currentVersion,
      })
      // A feed change during the request supersedes this result.
      if (!stopped && current === generation && options.feed() === "preview") options.onUpdate(release)
    } catch (error) {
      options.logger.debug({ err: error }, "Failed to refresh preview release information")
    }
  }

  void refresh()
  const timer = setInterval(() => void refresh(), pollIntervalMs)

  return {
    refresh() {
      void refresh()
    },
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

async function fetchLatestPreview(args: {
  repo: string
  currentVersion: string
}): Promise<LatestReleaseInfo | null> {
  const normalizedRepo = args.repo.trim()
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalizedRepo)) {
    throw new Error(`Invalid GitHub repo: ${args.repo}`)
  }

  const headers = { Accept: "application/vnd.github+json", "User-Agent": "CodeNomad-CLI" }
  const apiUrl = `https://api.github.com/repos/${normalizedRepo}/releases?per_page=30`
  const response = await fetch(apiUrl, { headers })

  if (!response.ok) {
    throw new Error(`GitHub releases API responded with ${response.status}`)
  }

  const list = (await response.json()) as GithubReleaseListItem[]
  const lookupInstalled = async (tag: string) => {
    const installed = await fetch(`https://api.github.com/repos/${normalizedRepo}/releases/tags/${encodeURIComponent(tag)}`, { headers })
    return installed.ok ? (await installed.json()) as GithubReleaseListItem : null
  }
  const latest = await findPreviewRelease(Array.isArray(list) ? list : [], args.currentVersion, lookupInstalled)
  const tag = latest ? tagOf(latest) : ""
  const version = stripTagPrefix(tag)
  if (!latest || !version) return null

  return {
    version,
    tag,
    url: latest.html_url ?? `https://github.com/${normalizedRepo}/releases/tag/${encodeURIComponent(tag)}`,
    channel: latest.prerelease === true ? "preview" : "stable",
    publishedAt: latest.published_at ?? latest.created_at,
    notes: latest.body,
  }
}
