interface NormalizedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

export function compareVersionStrings(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  return compareVersions(left, right)
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
