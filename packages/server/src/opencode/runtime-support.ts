/** Fixed for this CodeNomad release; never derive admission from npm at runtime. */
export const MINIMUM_OPENCODE_VERSION = "2.0.11"
export const OPENCODE_UPDATE_REQUIRED = "opencode_update_required"

export function supportsOpenCodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_OPENCODE_VERSION.split(".").map(Number)
  return major === minimumMajor && (minor! > minimumMinor! || (minor === minimumMinor && patch! >= minimumPatch!))
}

export class UnsupportedOpenCodeError extends Error {
  readonly code = OPENCODE_UPDATE_REQUIRED
  readonly statusCode = 426
  readonly minimumVersion = MINIMUM_OPENCODE_VERSION
  constructor(readonly actualVersion: string) {
    super(`${OPENCODE_UPDATE_REQUIRED}: OpenCode ${actualVersion}; requires stable OpenCode >= ${MINIMUM_OPENCODE_VERSION} and < 3.0.0`)
    this.name = "UnsupportedOpenCodeError"
  }
}

export function assertSupportedOpenCode(version: string): void {
  if (!supportsOpenCodeVersion(version)) throw new UnsupportedOpenCodeError(version)
}
