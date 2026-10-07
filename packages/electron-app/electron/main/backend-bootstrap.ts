import http from "node:http"

export interface BackendBootstrapCookie {
  url: string
  name: string
  value: string
  httpOnly: true
  path: "/"
  sameSite: "lax"
}

interface NativeCookie {
  name: string
  value: string
  domain?: string
  path?: string
  httpOnly?: boolean
  sameSite?: string
  secure?: boolean
}

/** One gate for the native cookie store, retained across coordinator resets.
 * A cleanup failure poisons admission; resetting a generation cannot clear it.
 */
export function createBackendCookieInstaller(cookies: {
  set(cookie: BackendBootstrapCookie): Promise<void>
  get(filter: { url: string; name: string }): Promise<NativeCookie[]>
  remove(url: string, name: string): Promise<void>
}) {
  let tail = Promise.resolve()
  let fenced = false
  return (cookie: BackendBootstrapCookie, isCurrent: () => boolean): Promise<boolean> => {
    const operation = tail.then(async () => {
      if (fenced) throw new Error("Native bootstrap cookie cleanup remains unconfirmed")
      if (!isCurrent()) return false
      const sameKey = (value: NativeCookie) => value.name === cookie.name && value.path === cookie.path
        && value.domain === new URL(cookie.url).hostname
      const read = () => cookies.get({ url: cookie.url, name: cookie.name })
      const existing = await read()
      if (!isCurrent()) return false
      if (existing.some(value => sameKey(value) && value.value !== cookie.value)) {
        throw new Error("Native bootstrap cookie identity is already occupied")
      }
      const cleanup = async () => {
        try {
          if ((await read()).some(value => sameKey(value) && value.value === cookie.value)) {
            await cookies.remove(cookie.url, cookie.name)
            if ((await read()).some(value => sameKey(value) && value.value === cookie.value)) {
              throw new Error("Native bootstrap cookie removal was not confirmed")
            }
          }
        } catch {
          fenced = true
          throw new Error("Native bootstrap cookie cleanup remains unconfirmed")
        }
      }
      let installed = false
      let failure: { error: unknown } | undefined
      try {
        await cookies.set(cookie)
        installed = (await read()).some(value => sameKey(value) && value.value === cookie.value
          && value.httpOnly === true && value.sameSite === "lax" && value.secure !== true)
        if (installed && isCurrent()) return true
      } catch (error) {
        failure = { error }
      }
      await cleanup()
      if (failure) throw failure.error
      if (!installed) throw new Error("Native bootstrap cookie installation was not confirmed")
      return false
    })
    // Installation errors with confirmed cleanup permit a fresh generation, never
    // proof replay. Unconfirmed cleanup retains its separate, irreversible fence.
    tail = operation.then(() => {}, () => {})
    return operation
  }
}

/** Main-process only: exchange a private proof, never publish it or the cookie to IPC. */
export async function exchangeBackendBootstrap(
  origin: string,
  proof: string,
  expectedCookieName: string,
): Promise<BackendBootstrapCookie | undefined> {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(origin)
  if (!match || match[0] !== origin || Number(match[1]) > 65535
    || proof.length !== 43 || /[^A-Za-z0-9_-]/.test(proof)
    || !expectedCookieName || expectedCookieName.length > 256 || /[^A-Za-z0-9_-]/.test(expectedCookieName)) return undefined

  const body = JSON.stringify({ token: proof })
  return new Promise((resolve) => {
    let settled = false
    let response: http.IncomingMessage | undefined
    const finish = (cookie?: BackendBootstrapCookie) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      response?.destroy()
      request.destroy()
      resolve(cookie)
    }
    const request = http.request(`${origin}/api/auth/token`, {
      method: "POST",
      agent: false,
      maxHeaderSize: 8192,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (incoming) => {
      response = incoming
      let bytes = 0
      incoming.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 4096) finish()
      })
      incoming.on("error", () => finish())
      incoming.on("aborted", () => finish())
      incoming.on("end", () => {
        const cookies = incoming.headers["set-cookie"]
        const parts = cookies?.length === 1 ? cookies[0].split(";") : []
        const cookie = /^([A-Za-z0-9_-]{1,256})=([A-Za-z0-9_-]{43})$/.exec(parts[0] ?? "")
        const attributes = new Set(parts.slice(1).map(value => value.trim().toLowerCase()))
        finish(incoming.statusCode === 200 && cookie?.[1] === expectedCookieName && cookie[0] === parts[0]
          && parts.length === 4 && attributes.size === 3 && ["httponly", "path=/", "samesite=lax"].every(value => attributes.has(value)) ? {
          url: origin, name: expectedCookieName, value: cookie[2], httpOnly: true, path: "/", sameSite: "lax",
        } : undefined)
      })
      incoming.resume()
    })
    // Absolute deadline includes connection, headers and body, even if bytes trickle in.
    const timer = setTimeout(() => finish(), 5000)
    request.on("error", () => finish())
    request.end(body)
  })
}
