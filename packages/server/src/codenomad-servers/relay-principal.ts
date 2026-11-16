import type { FastifyReply, FastifyRequest } from "fastify"
import type { AuthManager } from "../auth/manager"
import type { RemoteControlManager } from "../remote-control/manager"

/** One admitted remote request retains its original principal through dispatch and publication. */
export function createRelayPrincipalBinding(deps: {
  auth: AuthManager
  devices: Pick<RemoteControlManager, "isDeviceAuthorized">
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
   * Devices also end when `alive` turns false (checked with device validity).
   */
  const lifetime = (request: FastifyRequest, alive: () => boolean = () => true) => {
    const principal = deps.auth.getSessionFromRequest(request)
    if (!principal) return null
    const controller = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    let releaseSession = () => {}
    const release = () => { clearInterval(timer); releaseSession() }
    const end = () => { release(); controller.abort() }
    if (principal.sessionId.startsWith("remote-device:")) {
      const id = principal.sessionId.slice("remote-device:".length)
      const check = () => { if (!deps.devices.isDeviceAuthorized(id) || !alive()) end() }
      check()
      if (!controller.signal.aborted) { timer = setInterval(check, 250); timer.unref() }
    } else {
      releaseSession = deps.auth.onSessionInvalidated(principal.sessionId, end)
    }
    return { key: principal.sessionId, signal: controller.signal, release }
  }
  return { bind, lifetime, signal: (request: FastifyRequest) => principals.get(request) }
}
