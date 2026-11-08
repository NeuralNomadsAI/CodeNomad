import type { CookiesSetDetails } from "electron"

export interface RemoteSessionCookie {
  origin: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: "lax" | "strict" | "none"
  expires?: number
}

/** Only a host cookie for the selected server; never accept a renderer-supplied domain. */
export function validateRemoteCookie(value: unknown, origin: string): RemoteSessionCookie {
  const cookie = value as RemoteSessionCookie | null
  if (!cookie || cookie.origin !== origin
    || Object.keys(cookie).some((key) => !["origin", "name", "value", "path", "secure", "httpOnly", "sameSite", "expires"].includes(key))
    || typeof cookie.name !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/.test(cookie.name)
    || typeof cookie.value !== "string" || cookie.value.length > 4096 || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(cookie.value)
    || typeof cookie.path !== "string" || !cookie.path.startsWith("/") || cookie.path.length > 2048 || /[^\x21-\x7E]|;/.test(cookie.path)
    || typeof cookie.secure !== "boolean" || typeof cookie.httpOnly !== "boolean"
    || !["lax", "strict", "none"].includes(cookie.sameSite)
    || (cookie.secure && new URL(origin).protocol !== "https:")
    || (cookie.sameSite === "none" && !cookie.secure)
    || (cookie.name.startsWith("__Secure-") && !cookie.secure)
    || (cookie.name.startsWith("__Host-") && (!cookie.secure || cookie.path !== "/"))
    || (cookie.expires !== undefined && (!Number.isSafeInteger(cookie.expires) || cookie.expires < 0 || cookie.expires > 253402300799))) {
    throw new Error("Invalid remote session cookie")
  }
  return { origin, name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, ...(cookie.expires === undefined ? {} : { expires: cookie.expires }) }
}

export function remoteCookieDetails(cookie: RemoteSessionCookie): CookiesSetDetails {
  return { url: cookie.origin, name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite === "none" ? "no_restriction" : cookie.sameSite, ...(cookie.expires === undefined ? {} : { expirationDate: cookie.expires }) }
}
