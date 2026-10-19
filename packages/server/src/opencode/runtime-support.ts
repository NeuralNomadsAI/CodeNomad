/**
 * Native plugins share the daemon's Effect/SDK rather than embedding a second
 * runtime. 2.0.27 supplies Effect 4.0.1 and Schema.isStartingWith consumed by the
 * current schemas; 2.0.26 fails the isolated plugin-loading regression.
 * See dev-docs/OPENCODE_V2_COMPATIBILITY.md for the demonstrated ABI boundary.
 */
export const MINIMUM_OPENCODE_VERSION = "2.0.27"
/** Qualification target, independent of the technically required minimum. */
export const RECOMMENDED_OPENCODE_VERSION = "2.0.32"
export const OPENCODE_UPDATE_REQUIRED = "opencode_update_required"

export function isBelowOpenCodeMinimum(version: string): boolean {
  // These historical V2 beta publications predate the stable event contract.
  if (/^0\.0\.0-beta-\d+$/.test(version)) return true
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version)
  // Custom/prerelease labels are unverified, not automatically incompatible.
  // Their authenticated API contract is inspected before functional requests.
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_OPENCODE_VERSION.split(".").map(Number)
  return major! < minimumMajor! || (major === minimumMajor && (minor! < minimumMinor!
    || (minor === minimumMinor && patch! < minimumPatch!)))
}

export type OpenCodeIncompatibility = "plugin_runtime" | "step_timestamp" | "canonical_api" | "session_environment"

export class UnsupportedOpenCodeError extends Error {
  readonly code = OPENCODE_UPDATE_REQUIRED
  readonly statusCode = 426
  readonly minimumVersion = MINIMUM_OPENCODE_VERSION
  constructor(readonly actualVersion: string, readonly reason: OpenCodeIncompatibility = "plugin_runtime") {
    super(`${OPENCODE_UPDATE_REQUIRED}: OpenCode ${actualVersion}; ${reason === "plugin_runtime"
      ? `requires the native Effect 4.0.1/Schema plugin runtime introduced in ${MINIMUM_OPENCODE_VERSION}`
      : reason === "step_timestamp" ? "requires the native session.step.started.data.started timestamp introduced in 2.0.7"
      : reason === "session_environment" ? "requires PUT /api/session/{sessionID}/environment with variables"
        : "does not expose the canonical session, permission, Form and inbox API contract"}`)
    this.name = "UnsupportedOpenCodeError"
  }
}

export function assertSupportedOpenCode(version: string): void {
  if (isBelowOpenCodeMinimum(version)) throw new UnsupportedOpenCodeError(version)
}
