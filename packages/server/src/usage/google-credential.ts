import { createHash } from "node:crypto"
import { fetchBoundedJson } from "./bounded-fetch"
import { asObject, getString } from "./shared"
import type { AuthFile } from "./types"

// Public installed-application client, embedded by Gemini CLI itself:
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts
const GEMINI_CLIENT = {
  client_id: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  client_secret: "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",
}
// Public installed-application client:
// https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/constants.ts
const ANTIGRAVITY_CLIENT = {
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  client_secret: "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",
}
/** Server-only client lookup; tests replace it with synthetic installed-app clients. */
export const googleOAuthClients = {
  get(methodID: string) { return methodID === "antigravity" ? ANTIGRAVITY_CLIENT : GEMINI_CLIENT },
}
const MAX_IDENTITIES = 32
const MAX_SECRET_LENGTH = 16_384

interface GoogleCredential {
  methodID: "gemini-cli" | "antigravity"
  identity: string
  access: string | null
  refresh: string | null
  expires: number
  project: string | null
}

/** Server-only. Client selection comes exclusively from the native method. */
export function googleCredential(auth: AuthFile): GoogleCredential | null {
  const entry = asObject(auth.google)
  if (entry?.type !== "oauth" || (entry.methodID !== "gemini-cli" && entry.methodID !== "antigravity")) return null
  const access = getString(entry.access)
  const packed = getString(entry.refresh)
  if ((access?.length ?? 0) > MAX_SECRET_LENGTH || (packed?.length ?? 0) > MAX_SECRET_LENGTH) return null
  const [refresh, project, managedProject] = (packed ?? "").split("|")
  return {
    methodID: entry.methodID,
    identity: createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
    access,
    refresh: getString(refresh),
    expires: typeof entry.expires === "number" && Number.isFinite(entry.expires) ? entry.expires : 0,
    // Match the declared client's saved-project priority.
    project: entry.methodID === "gemini-cli"
      ? getString(project) ?? getString(managedProject)
      : getString(managedProject) ?? getString(project),
  }
}

/** Reject even otherwise valid quota identities when they echo a credential or packed context. */
export function googleQuotaIdentityGuard(auth: AuthFile, access: string) {
  const entry = asObject(auth.google)
  const secrets = [access, getString(entry?.access), ...(getString(entry?.refresh) ?? "").split("|"),
    googleOAuthClients.get("gemini-cli").client_secret, googleOAuthClients.get("antigravity").client_secret].filter((value): value is string => Boolean(value))
    .map(value => value.toLowerCase())
  return (value: string) => !secrets.some(secret => value.toLowerCase().includes(secret))
}

/** Only access tokens and expiries survive a refresh; OpenCode remains the connection owner. */
export function createGoogleTokenReader() {
  const cache = new Map<string, { access: string; expires: number }>()
  const pending = new Map<string, Promise<string>>()
  return async (credential: GoogleCredential, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    const now = Date.now()
    for (const [key, value] of cache) if (value.expires <= now) cache.delete(key)
    // Use the native token up to its actual deadline, without an early-refresh lead.
    if (credential.access && credential.expires > now) return credential.access
    const cached = cache.get(credential.identity)
    if (cached) return cached.access
    const inFlight = pending.get(credential.identity)
    if (inFlight) return inFlight
    if (!credential.refresh || pending.size >= MAX_IDENTITIES) throw new Error("Google usage unavailable")
    const request = (async () => {
      const started = Date.now()
      const payload = asObject(await fetchBoundedJson("https://oauth2.googleapis.com/token",
        { "Content-Type": "application/x-www-form-urlencoded" }, signal, undefined, { method: "POST", body: new URLSearchParams({
          grant_type: "refresh_token", refresh_token: credential.refresh!,
          ...googleOAuthClients.get(credential.methodID),
        }) }))
      const access = getString(payload?.access_token)
      const seconds = payload?.expires_in
      const expires = typeof seconds === "number" ? started + seconds * 1000 : NaN
      if (!access || access.length > MAX_SECRET_LENGTH || !Number.isFinite(expires) || expires <= Date.now()) {
        throw new Error("Google usage unavailable")
      }
      signal.throwIfAborted()
      // Never retain a refresh_token supplied by the response.
      if (cache.size >= MAX_IDENTITIES) cache.delete(cache.keys().next().value!)
      cache.set(credential.identity, { access, expires })
      return access
    })().finally(() => pending.delete(credential.identity))
    pending.set(credential.identity, request)
    return request
  }
}
