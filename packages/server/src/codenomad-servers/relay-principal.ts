import type { FastifyReply, FastifyRequest } from "fastify"
import type { AuthManager } from "../auth/manager"
import type { RemoteControlManager } from "../remote-control/manager"
import { isRemoteSocket } from "../remote-control/request-origin"

/** One admitted remote request retains its original principal through dispatch and publication. */
export function createRelayPrincipalBinding(deps: {
  auth: Pick<AuthManager, "getSessionFromRequest" | "isAuthEnabled" | "isSessionValid" | "onPrincipalLoggedOut" | "onSessionInvalidated">
  devices: Pick<RemoteControlManager, "isDeviceAuthorized" | "isPreviewDeviceAuthorized" | "onPreviewDeviceInvalidated">
  local(request: FastifyRequest): boolean
}) {
  const principals = new WeakMap<FastifyRequest, AbortSignal>()
  const bind = (request: FastifyRequest, reply: FastifyReply): void => {
    if (principals.has(request)) return
    if (deps.local(request)) return
    const principal = deps.auth.getSessionFromRequest(request)
    if (!principal) {
      reply.header("connection", "close").code(401).send({ error: "auth" })
      return
    }
    const controller = new AbortController()
    principals.set(request, controller.signal)
    let active = true
    let releaseSession = () => {}
    let deviceTimer: ReturnType<typeof setInterval> | undefined
    const release = () => {
      if (!active) return
      active = false
      clearInterval(deviceTimer)
      releaseSession()
      request.raw.off("aborted", abort)
      reply.raw.off("close", abort)
      reply.raw.off("finish", release)
    }
    const abort = () => {
      if (!active) return
      controller.abort()
      reply.raw.destroy()
      release()
    }
    request.raw.once("aborted", abort)
    reply.raw.once("close", abort)
    reply.raw.once("finish", release)
    if (principal.sessionId.startsWith("remote-device:")) {
      const id = principal.sessionId.slice("remote-device:".length)
      // Device socket revocation closes immediately; this read-only check also covers idle expiry.
      const check = () => { if (!deps.devices.isDeviceAuthorized(id)) abort() }
      check()
      if (active) { deviceTimer = setInterval(check, 250); deviceTimer.unref() }
    } else {
      releaseSession = deps.auth.onSessionInvalidated(principal.sessionId, abort)
    }
  }
  /**
   * A principal's lifetime beyond one request, for resources such as preview capabilities.
   * Admission reads current authority; notifications end already-admitted transfers.
   */
  const lifetime = (request: FastifyRequest, host: string) => {
    const principal = deps.auth.getSessionFromRequest(request)
    if (!principal) return null
    const controller = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    const cleanups: (() => void)[] = []
    let active = true
    const release = () => {
      if (!active) return
      active = false
      clearInterval(timer)
      for (const cleanup of cleanups.splice(0)) cleanup()
    }
    const end = () => { release(); controller.abort() }
    const own = (cleanup: () => void) => { if (active) cleanups.push(cleanup); else cleanup() }
    const key = principal.sessionId
    const ingress = isRemoteSocket(request.raw.socket)
    const device = key.startsWith("remote-device:") ? key.slice("remote-device:".length) : undefined
    const current = () => {
      if (!active) return false
      const valid = device !== undefined ? deps.devices.isPreviewDeviceAuthorized(device, host, ingress)
        : key === "auth-disabled" ? !deps.auth.isAuthEnabled() : deps.auth.isSessionValid(key)
      if (!valid) end()
      return valid
    }
    try {
      if (!current()) return null
      if (device !== undefined || key === "auth-disabled") {
        own(deps.auth.onPrincipalLoggedOut(id => { if (id === key) end() }))
      }
      if (device !== undefined) {
        own(deps.devices.onPreviewDeviceInvalidated(device, ingress, end))
        // Idle expiry can occur without a revocation event.
        if (active) { timer = setInterval(current, 250); timer.unref() }
      } else if (key !== "auth-disabled") own(deps.auth.onSessionInvalidated(key, end))
      return current() ? { key, signal: controller.signal, current, release, ingress, host } : null
    } catch (error) {
      release()
      throw error
    }
  }
  return { bind, lifetime, signal: (request: FastifyRequest) => principals.get(request) }
}
