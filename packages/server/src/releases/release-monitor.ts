import { fetch } from "undici"
import type { LatestReleaseInfo } from "../api-types"
import type { Logger } from "../logger"

const RELEASES_API_URL = "https://api.github.com/repos/NeuralNomadsAI/CodeNomad/releases/latest"
interface ReleaseMonitorOptions {
  currentVersion: string
  logger: Logger
  onUpdate: (release: LatestReleaseInfo | null) => void
}

interface GithubReleaseResponse {
  tag_name?: string
  name?: string
  html_url?: string
  body?: string
  published_at?: string
  created_at?: string
  prerelease?: boolean
}

interface NormalizedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

export interface ReleaseMonitor {
  stop(): void
}

export function startReleaseMonitor(options: ReleaseMonitorOptions): ReleaseMonitor {
  let stopped = false

  const refreshRelease = async () => {
    if (stopped) return
    try {
      const release = await fetchLatestRelease(options)
      options.onUpdate(release)
    } catch (error) {
      options.logger.warn({ err: error }, "Failed to refresh release information")
    }
  }

  void refreshRelease()

  return {
    stop() {
      stopped = true
    },
  }
}

export function compareVersionStrings(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  return compareVersions(left, right)
}

async function fetchLatestRelease(options: ReleaseMonitorOptions): Promise<LatestReleaseInfo | null> {
  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "CodeNomad-CLI",
    },
  })

  if (!response.ok) {
    throw new Error(`Release API responded with ${response.status}`)
  }

  const json = (await response.json()) as GithubReleaseResponse
  const tagFromServer = json.tag_name || json.name
  if (!tagFromServer) {
    return null
  }

  const normalizedVersion = stripTagPrefix(tagFromServer)
  if (!normalizedVersion) {
    return null
  }

  const current = parseVersion(options.currentVersion)
  const remote = parseVersion(normalizedVersion)

  if (compareVersions(remote, current) <= 0) {
    return null
  }

  return {
    version: normalizedVersion,
    tag: tagFromServer,
    url: json.html_url ?? `https://github.com/NeuralNomadsAI/CodeNomad/releases/tag/${encodeURIComponent(tagFromServer)}`,
    channel: json.prerelease || normalizedVersion.includes("-") ? "dev" : "stable",
    publishedAt: json.published_at ?? json.created_at,
    notes: json.body,
  }
}

export function stripTagPrefix(tag: string | undefined): string | null {
  if (!tag) return null
  const trimmed = tag.trim()
  if (!trimmed) return null
  return trimmed.replace(/^v/i, "")
}

function parseVersion(value: string): NormalizedVersion {
  const normalized = stripTagPrefix(value) ?? "0.0.0"
  const dashIndex = normalized.indexOf("-")
  const core = dashIndex >= 0 ? normalized.slice(0, dashIndex) : normalized
  const prerelease = dashIndex >= 0 ? normalized.slice(dashIndex + 1) : null
  const [major = 0, minor = 0, patch = 0] = core.split(".").map((segment) => {
    const parsed = Number.parseInt(segment, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  return {
    major,
    minor,
    patch,
    prerelease,
  }
}

function compareVersions(a: NormalizedVersion, b: NormalizedVersion): number {
  if (a.major !== b.major) {
    return a.major > b.major ? 1 : -1
  }
  if (a.minor !== b.minor) {
    return a.minor > b.minor ? 1 : -1
  }
  if (a.patch !== b.patch) {
    return a.patch > b.patch ? 1 : -1
  }

  const aPre = a.prerelease && a.prerelease.length > 0 ? a.prerelease : null
  const bPre = b.prerelease && b.prerelease.length > 0 ? b.prerelease : null

  if (aPre === bPre) {
    return 0
  }
  if (!aPre) {
    return 1
  }
  if (!bPre) {
    return -1
  }
  return aPre.localeCompare(bPre)
}
