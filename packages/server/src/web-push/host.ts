import path from "node:path"
import type { AuthManager } from "../auth/manager"
import type { RemoteControlManager } from "../remote-control/manager"
import type { SettingsService } from "../settings/service"
import type { WorkspaceManager } from "../workspaces/manager"
import type { EventBus } from "../events/bus"
import { PushService } from "./service"
import { attachLocalPushEvents } from "./local-events"
import { validateSubject } from "./transport"

// HTTP, HTTPS and ingress borrow one host producer and one private queue.
const hosts = new WeakMap<AuthManager, { push: PushService; users: number; dispose(): void }>()

export function readPushPolicy(env: NodeJS.ProcessEnv = process.env) {
  const policy = env.CODENOMAD_WEB_PUSH ?? ""
  if (policy !== "" && policy.trim().toLowerCase() !== "disabled") throw new Error('CODENOMAD_WEB_PUSH accepts only "disabled"')
  return { disabled: policy !== "", subject: validateSubject(env.CODENOMAD_WEB_PUSH_SUBJECT ?? "https://github.com/NeuralNomadsAI/CodeNomad") }
}

export function acquirePushHost(deps: {
  authManager: AuthManager; remoteControlManager: RemoteControlManager; settings: SettingsService
  workspaceManager: WorkspaceManager; eventBus: EventBus
}) {
  let host = hosts.get(deps.authManager)
  if (!host) {
    const { disabled, subject } = readPushPolicy()
    const push = new PushService({
      file: path.join(path.dirname(deps.settings.configYamlPathForAuthority()), "web-push.json"),
      enabled: () => !disabled && deps.settings.multiBackendEnabled(),
      projects: () => deps.workspaceManager.list().map(w => w.id),
      epoch: publicKey => deps.authManager.pushCredentialEpoch(publicKey),
      channelEpoch: principal => principal.channel === "tunnel" ? deps.remoteControlManager.tunnelPushEpoch() : "",
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
    const releasePassword = deps.authManager.onPasswordChanged(() => push.revoke())
    const releaseLogout = deps.authManager.onPrincipalLoggedOut(id => push.revoke(id))
    const releaseDevice = deps.remoteControlManager.onPushRevoked((id, channel) => push.revoke(id ?? undefined, channel))
    const releaseEvents = attachLocalPushEvents({
      eventBus: deps.eventBus, workspaceManager: deps.workspaceManager, interested: id => push.interested(id),
      emit: event => { void push.publish(event) },
    })
    host = { push, users: 0, dispose: () => { releaseEvents(); releasePassword(); releaseLogout(); releaseDevice(); push.close() } }
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
