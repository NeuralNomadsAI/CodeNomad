/** Set by the desktop host on the backend it launches, only for a non-default data profile. */
export const DESKTOP_PROFILE_ENVIRONMENT = "CODENOMAD_DESKTOP_PROFILE"

const MAX_PROFILE_LENGTH = 128

/** Display-only: the host already resolved and validated the profile; reject anything unprintable. */
export function readDesktopProfile(environment: Record<string, string | undefined>): string | undefined {
  const value = environment[DESKTOP_PROFILE_ENVIRONMENT]?.trim()
  if (!value || value.length > MAX_PROFILE_LENGTH || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined
  return value
}
