import path from "node:path"
import type { AuthManager } from "../auth/manager"
import type { RemoteControlManager } from "../remote-control/manager"
import type { SettingsService } from "../settings/service"
import type { WorkspaceManager } from "../workspaces/manager"
import type { EventBus } from "../events/bus"
import { PushInputError, PushService } from "./service"
import { attachLocalPushEvents } from "./local-events"
import { validateSubject } from "./transport"

// HTTP, HTTPS and ingress borrow one host producer and one private queue.
type PushApi = Pick<PushService, "status" | "consent" | "subscribe" | "unsubscribe" | "resolve" | "publish" | "interested" | "focus">
const hosts = new WeakMap<AuthManager, { push: PushApi; users: number; dispose(): void }>()

export function readPushPolicy(env: NodeJS.ProcessEnv = process.env) {
  const policy = env.CODENOMAD_WEB_PUSH ?? ""
  if (policy !== "" && policy.trim().toLowerCase() !== "disabled") throw new Error('CODENOMAD_WEB_PUSH accepts only "disabled"')
  return { disabled: policy !== "", subject: validateSubject(env.CODENOMAD_WEB_PUSH_SUBJECT ?? "https://github.com/NeuralNomadsAI/CodeNomad") }
}

export function acquirePushHost(deps: {
  authManager: AuthManager; remoteControlManager: RemoteControlManager; settings: SettingsService
  workspaceManager: WorkspaceManager; eventBus: EventBus
  authorityReady?: () => boolean
}) {
  let host = hosts.get(deps.authManager)
  if (!host) {
    const { disabled, subject } = readPushPolicy()
    const enabled = () => !disabled && deps.settings.multiBackendEnabled()
    let service: PushService | undefined
    const getService = () => {
      if (!enabled() || deps.authorityReady?.() === false) return undefined
      return service ??= new PushService({
        file: path.join(path.dirname(deps.settings.configYamlPathForAuthority()), "web-push.json"),
        enabled,
        projects: () => deps.workspaceManager.list().map(w => w.id),
        epoch: publicKey => deps.authManager.pushCredentialEpoch(publicKey),
        channelEpoch: principal => {
          const tunnel = principal.channel === "tunnel" ? deps.remoteControlManager.tunnelPushEpoch() : ""
          const device = principal.id.startsWith("remote-device:") ? deps.remoteControlManager.devicePushEpoch(principal.id.slice(14)) : ""
          return device ? `${tunnel}:${device}` : tunnel
        },
        qualifyRoute: async route => {
          const workspace = deps.workspaceManager.get(route.instanceId)
          const connection = deps.workspaceManager.getExistingSharedServiceConnection(route.instanceId)
          if (!workspace || !connection) return false
          const signal = AbortSignal.timeout(5000)
          const session = await connection.client.session.get({ sessionID: route.sessionId }, { signal })
          connection.assertCurrent()
          if (signal.aborted || deps.workspaceManager.get(route.instanceId) !== workspace
            || deps.workspaceManager.getExistingSharedServiceConnection(route.instanceId) !== connection || session.id !== route.sessionId) return false
          const owned = await deps.workspaceManager.ownsLocation(route.instanceId, session.location, connection.client, { signal, purpose: "event", strict: true })
          connection.assertCurrent()
          return owned && !signal.aborted && deps.workspaceManager.get(route.instanceId) === workspace
            && deps.workspaceManager.getExistingSharedServiceConnection(route.instanceId) === connection
        },
        authority: principal => principal.id.startsWith("remote-device:")
          ? deps.remoteControlManager.pushAuthority(principal.id.slice(14), principal.channel, principal.origin)
          : principal.channel === "https" && deps.remoteControlManager.directHttpsOrigins().includes(principal.origin)
            && deps.authManager.isSessionValid(principal.id) ? "active" : "revoked",
        watch: (principal, revoke) => principal.id.startsWith("remote-device:")
          ? () => {} : deps.authManager.onSessionInvalidated(principal.id, revoke),
        subject,
      })
    }
    const required = () => {
      const current = getService()
      if (!current) throw new PushInputError("Web Push disabled")
      return current
    }
    const invalidateDevice = (id: string) => {
      if (id.startsWith("remote-device:")) deps.remoteControlManager.invalidatePushConsent(id.slice(14))
    }
    const push: PushApi = {
      status: principal => getService()?.status(principal) ?? { enabled: false, subscribed: false },
      consent: principal => required().consent(principal),
      focus: (principal, value) => service?.focus(principal, value),
      subscribe: (principal, value) => required().subscribe(principal, value),
      unsubscribe: principal => { invalidateDevice(principal.id); service?.unsubscribe(principal) },
      resolve: async (principal, token) => getService()?.resolve(principal, token),
      publish: async event => { await getService()?.publish(event) },
      interested: id => getService()?.interested(id) ?? false,
    }
    const releasePassword = deps.authManager.onPasswordChanged(() => service?.revoke())
    const releaseLogout = deps.authManager.onPrincipalLoggedOut(id => { invalidateDevice(id); service?.revoke(id) })
    const releaseDevice = deps.remoteControlManager.onPushRevoked((id, channel) => service?.revoke(id ?? undefined, channel))
    const start = setInterval(getService, 250)
    start.unref()
    getService()
    const releaseEvents = attachLocalPushEvents({
      eventBus: deps.eventBus, workspaceManager: deps.workspaceManager, interested: id => push.interested(id),
      emit: event => { void push.publish(event) },
    })
    host = { push, users: 0, dispose: () => { clearInterval(start); releaseEvents(); releasePassword(); releaseLogout(); releaseDevice(); service?.close() } }
    hosts.set(deps.authManager, host)
  }
  host.users++
  const owned = host
  let released = false
  return { push: host.push, release: () => {
    if (released) return
    released = true
    if (--owned.users === 0) { owned.dispose(); hosts.delete(deps.authManager) }
  } }
}
