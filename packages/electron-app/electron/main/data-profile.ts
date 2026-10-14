import { createHash } from "node:crypto"

/**
 * Desktop data profiles. The installed version never selects a profile: packaged builds use the
 * default profile (after a one-time transition, see profile-transition.ts), and developers isolate
 * data explicitly with CODENOMAD_PROFILE. Grammar and vectors are shared with Tauri's
 * `data_profile.rs` through data-profile-vectors.json; see dev-docs/DESKTOP_DATA_PROFILES.md.
 */
export const PROFILE_ENVIRONMENT = "CODENOMAD_PROFILE"
export const LEGACY_CHANNEL_ENVIRONMENT = "CODENOMAD_UPDATE_CHANNEL"
/** Set by the host on the backend it launches; present only for non-default profiles. */
export const BACKEND_PROFILE_ENVIRONMENT = "CODENOMAD_DESKTOP_PROFILE"

/** Storage key of the default profile; it keeps the historical unscoped locations. */
export const DEFAULT_PROFILE_KEY = "stable"
export const DEFAULT_PROFILE_NAME = "default"
/** Profiles that older packaged builds selected automatically from their version label. */
export const TRANSITION_PROFILE_KEYS = [DEFAULT_PROFILE_KEY, "dev", "dev-v2"] as const

const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

export class InvalidProfileError extends Error {
  constructor(readonly value: string) {
    super(`Invalid ${PROFILE_ENVIRONMENT} value ${JSON.stringify(value)}: use 1-64 ASCII letters, digits, '.', '_' or '-', starting with a letter or digit.`)
    this.name = "InvalidProfileError"
  }
}

// ASCII-only trimming and case folding keep the grammar identical to Rust's `is_ascii_whitespace`/`to_ascii_lowercase`.
const asciiTrim = (value: string) => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")

/** Parses an explicit profile name into its storage key; "default" and "stable" both denote the default profile. */
export function parseProfileName(raw: string): string {
  const lower = asciiTrim(raw).replace(/[A-Z]/g, (character) => character.toLowerCase())
  if (!PROFILE_NAME.test(lower)) throw new InvalidProfileError(raw)
  return lower === DEFAULT_PROFILE_NAME ? DEFAULT_PROFILE_KEY : lower
}

/** Pre-profile Electron channel normalization, kept verbatim so existing scopes stay reachable. */
export function legacyChannelKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
}

export function profileDisplayName(key: string): string {
  return key === DEFAULT_PROFILE_KEY ? DEFAULT_PROFILE_NAME : key
}

export interface ExplicitProfile {
  key: string
  source: "profile" | "legacy-channel" | "unpackaged"
}

/** Explicit selection wins over everything; returns undefined when a packaged launch needs the transition. */
export function resolveExplicitProfile(environment: Record<string, string | undefined>, packaged: boolean): ExplicitProfile | undefined {
  const profile = environment[PROFILE_ENVIRONMENT]
  if (profile && asciiTrim(profile)) return { key: parseProfileName(profile), source: "profile" }
  const channel = environment[LEGACY_CHANNEL_ENVIRONMENT]
  if (channel?.trim()) return { key: legacyChannelKey(channel), source: "legacy-channel" }
  return packaged ? undefined : { key: "dev", source: "unpackaged" }
}

export interface ProfileScope {
  scoped: boolean
  suffix: string
  scopeName: string
}

export function profileScope(key: string, configIdentity: string, defaultIdentity: string): ProfileScope {
  const suffix = createHash("sha256").update(`${key}\0${configIdentity}`).digest("hex").slice(0, 16)
  return {
    scoped: key !== DEFAULT_PROFILE_KEY || configIdentity !== defaultIdentity,
    suffix,
    scopeName: `${key}-${suffix}`,
  }
}
