/**
 * CodeNomad consumes OpenCode 2.1's native replay contract through the pinned
 * 2.1 client reducer and codecs: provider replay data is `native` on events and
 * messages, summary compactions reference `metadata.keepID` (older kept text in
 * `metadata.recent`) and provider windows live in `native.messages`. 2.0.x
 * daemons emit the retired `state`/`providerState`/`resultState`/`recent` shapes.
 * OpenCode 2.1.2 also fixes Code Mode jobs violating JavaScript run-to-completion:
 * 2.1.0/2.1.1 lose shared updates and resume async callers before the first await.
 * Reproduced by scripts/test-codemode-jobs-native.mjs against isolated daemons.
 * OpenCode 2.1 reads data stored by older releases. See
 * dev-docs/OPENCODE_V2_COMPATIBILITY.md for the demonstrated boundary.
 */
export const MINIMUM_OPENCODE_VERSION = "2.1.2"
/** Qualification target, independent of the technically required minimum. */
export const RECOMMENDED_OPENCODE_VERSION = "2.1.2"
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

export type OpenCodeIncompatibility = "native_contract" | "canonical_api" | "session_environment"

export class UnsupportedOpenCodeError extends Error {
  readonly code = OPENCODE_UPDATE_REQUIRED
  readonly statusCode = 426
  readonly minimumVersion = MINIMUM_OPENCODE_VERSION
  constructor(readonly actualVersion: string, readonly reason: OpenCodeIncompatibility = "native_contract") {
    super(`${OPENCODE_UPDATE_REQUIRED}: OpenCode ${actualVersion}; ${reason === "native_contract"
      ? `requires the 2.1 native replay and compaction contract (native, metadata.keepID) and Code Mode job ordering fixed in ${MINIMUM_OPENCODE_VERSION}`
      : reason === "session_environment" ? "requires PUT /api/session/{sessionID}/environment with variables"
        : "does not expose the canonical session, permission, Form and inbox API contract"}`)
    this.name = "UnsupportedOpenCodeError"
  }
}

export function assertSupportedOpenCode(version: string): void {
  if (isBelowOpenCodeMinimum(version)) throw new UnsupportedOpenCodeError(version)
}
