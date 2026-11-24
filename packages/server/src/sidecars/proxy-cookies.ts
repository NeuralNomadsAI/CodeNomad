import { DEFAULT_AUTH_COOKIE_NAME } from "../auth/manager"
import { DEVICE_COOKIE_NAME } from "../remote-control/gate"

type Headers = Record<string, string | string[] | undefined>
const nameOf = (pair: string) => pair.split("=", 1)[0]!.trim()

function reserved(name: string, sessionCookie: string): boolean {
  // Desktop backends use codenomad_session_<process>_<time>. Cookies ignore
  // ports, so protect sibling backend cookies as well as this server's name.
  return name === sessionCookie || name === DEFAULT_AUTH_COOKIE_NAME
    || name.startsWith(`${DEFAULT_AUTH_COOKIE_NAME}_`) || name === DEVICE_COOKIE_NAME
}

export function sidecarRequestCookies(value: string | string[] | undefined, sessionCookie: string): string | undefined {
  const cookies = (Array.isArray(value) ? value.join("; ") : value ?? "").split(";")
    .map(part => part.trim()).filter(part => part && !reserved(nameOf(part), sessionCookie))
  return cookies.length ? cookies.join("; ") : undefined
}

export function sidecarResponseCookies(headers: Headers, sessionCookie: string): Headers {
  const result = { ...headers }
  for (const [key, value] of Object.entries(result)) {
    if (key.toLowerCase() === "set-cookie2") { delete result[key]; continue }
    if (key.toLowerCase() !== "set-cookie" || value === undefined) continue
    // Set-Cookie is not comma-separated (Expires itself contains a comma).
    const kept = (Array.isArray(value) ? value : [value]).filter(cookie => {
      const pair = cookie.split(";", 1)[0]!, name = nameOf(pair)
      // Reject nameless/malformed cookies: browsers may serialize them without
      // the leading '=', turning their value into an application cookie pair.
      return pair.indexOf("=") > 0 && /^[!#$%&'*+\-.^_`|~\w]+$/.test(name) && !reserved(name, sessionCookie)
    })
    if (!kept.length) delete result[key]
    else result[key] = Array.isArray(value) ? kept : kept[0]
  }
  return result
}
