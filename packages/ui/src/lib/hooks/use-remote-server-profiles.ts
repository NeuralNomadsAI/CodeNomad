import { createEffect, createSignal, onCleanup } from "solid-js"
import { serverApi } from "../api-client"
import { useI18n } from "../i18n"
import { openRemoteServerWindow, type RemoteWindowOpenOptions } from "../native/remote-window"
import { splitPairingLink } from "../remote-pairing-link"
import { canOpenRemoteWindows, isTauriHost } from "../runtime-env"
import { showAlertDialog } from "../../stores/alerts"
import { useConfig } from "../../stores/preferences"
import { carriesCredentials, classifyCodeNomadLink, codeNomadLinkName } from "../codenomad-link"
import { RemoteServerRequestError } from "../remote-server-request"
import type { RemoteServerProfile } from "../../../../server/src/api-types"

export type RemoteServerInput = {
  id?: string
  name: string
  baseUrl: string
  skipTlsVerify: boolean
}

export class RemoteServerProbeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RemoteServerProbeError" }
}

export function remoteServerErrorKey(error: unknown): string {
  const code = error instanceof RemoteServerProbeError || error instanceof RemoteServerRequestError ? error.code : "unreachable"
  return code === "save" ? "settings.preferenceSaveFailed"
    : code === "required" ? "settings.servers.dialog.errorRequired"
    : code === "credentials" ? "folderSelection.browseMenu.errorCredentials"
    : code === "invalid" ? "folderSelection.browseMenu.errorInvalid"
    : code === "tls_error" ? "remoteBrowse.tlsError"
    : code === "auth" || code === "needs_credentials" ? "authRecovery.credentials"
    : code === "pairing_expired" ? "remoteBrowse.pairingExpired"
    : code === "pairing_rate_limited" ? "remoteBrowse.pairingRateLimited"
    : code === "pairing_unavailable" ? "remoteBrowse.pairingUnavailable" : "remoteBrowse.unreachable"
}

/** Profile CRUD for the host. Owning views additionally fence their publication and focus. */
export function useRelayServerProfiles() {
  const config = useConfig()
  let alive = true
  const controllers = new Set<AbortController>()
  const enabled = () => alive && config.preferences().multiBackend === true
  const same = (a: RemoteServerProfile | undefined, b: RemoteServerProfile | undefined) =>
    a === b || !!a && !!b && a.id === b.id && a.baseUrl === b.baseUrl && a.skipTlsVerify === b.skipTlsVerify
  const capture = (profile?: RemoteServerProfile) => {
    const controller = new AbortController()
    controllers.add(controller)
    const current = () => enabled() && !controller.signal.aborted && (!profile || same(profile, config.remoteServers().find(p => p.id === profile.id)))
    return { signal: controller.signal, current, assert: () => { if (!current()) throw new DOMException("Obsolete server operation", "AbortError") },
      dispose: () => controllers.delete(controller) }
  }
  createEffect(() => { if (!enabled()) for (const controller of controllers) controller.abort() })
  onCleanup(() => { alive = false; for (const controller of controllers) controller.abort(); controllers.clear() })
  const submitServer = async (input: RemoteServerInput, _open = false, viewCurrent: () => boolean = () => true) => {
    input = { ...input }
    if (!enabled()) throw new DOMException("Server settings disabled", "AbortError")
    if (!input.baseUrl.trim()) throw new RemoteServerProbeError("required")
    if (carriesCredentials(input.baseUrl)) throw new RemoteServerProbeError("credentials")
    const link = classifyCodeNomadLink(input.baseUrl)
    if (!link) throw new RemoteServerProbeError("invalid")
    const saved = input.id ? config.remoteServers().find(p => p.id === input.id) : config.remoteServers().find(p => p.baseUrl === link.baseUrl)
    if (input.id && !saved) throw new DOMException("Removed server", "AbortError")
    const op = capture(saved)
    const current = () => op.current() && viewCurrent()
    const assert = () => { op.assert(); if (!viewCurrent()) throw new DOMException("Closed server edit", "AbortError") }
    const skipTlsVerify = link.kind === "pairing" ? false : input.skipTlsVerify
    try {
      assert()
      let baseUrl = link.kind === "address" && saved?.baseUrl === input.baseUrl.trim() ? saved.baseUrl : link.baseUrl
      if (!saved || link.kind === "pairing" || saved.baseUrl !== baseUrl || saved.skipTlsVerify !== skipTlsVerify) {
        const probe = await serverApi.probeRemoteServer({ baseUrl, skipTlsVerify }, op.signal)
        assert()
        if (!probe.ok) throw new RemoteServerProbeError(probe.errorCode ?? "unreachable")
        baseUrl = probe.normalizedUrl
      }
      assert()
      let profile: RemoteServerProfile
      try {
        profile = await config.saveRemoteServerProfile({ id: saved?.id, name: input.name.trim() || (!input.id && saved?.name) || codeNomadLinkName(baseUrl), baseUrl, skipTlsVerify }, current)
      } catch (error) {
        if (!current()) throw new DOMException("Obsolete server edit", "AbortError")
        throw new RemoteServerProbeError("save")
      }
      // The write may have changed the captured policy. Connect requires the committed exact new policy.
      if (!enabled() || !viewCurrent() || !same(profile, config.remoteServers().find(p => p.id === profile.id))) throw new DOMException("Obsolete saved server", "AbortError")
      if (link.kind === "pairing") await serverApi.connectRemoteServer(profile.id, { pairingLink: link.entryUrl }, op.signal)
      if (!enabled() || !viewCurrent() || !same(profile, config.remoteServers().find(p => p.id === profile.id))) throw new DOMException("Obsolete saved server", "AbortError")
      return profile
    } finally { op.dispose() }
  }
  const removeServer = async (profile: RemoteServerProfile) => {
    profile = { ...profile }
    const op = capture({ ...profile })
    try {
      op.assert()
      await serverApi.forgetRemoteServer(profile.id, op.signal)
      op.assert()
      try { await config.removeRemoteServerProfileAsync(profile.id, op.current) }
      catch (error) { op.assert(); throw new RemoteServerProbeError("save") }
    } finally { op.dispose() }
  }
  return { remoteServers: config.remoteServers, enabled, capture, submitServer, removeServer }
}

export function useRemoteServerProfiles() {
  const { t } = useI18n()
  const { remoteServers, saveRemoteServerProfile, markRemoteServerConnected, removeRemoteServerProfile } = useConfig()
  const [connectingServerId, setConnectingServerId] = createSignal<string | null>(null)

  const saveServer = async (input: RemoteServerInput, requestedWindow: boolean, windowOptions: RemoteWindowOpenOptions = {}) => {
    // A Remote Control pairing code is consumed by the window that opens it, so a pairing link opens one where possible.
    const pairing = splitPairingLink(input.baseUrl)
    const openWindow = requestedWindow || (pairing !== null && canOpenRemoteWindows())
    if (openWindow && !canOpenRemoteWindows()) {
      throw new Error("Remote server windows can only be opened from a local desktop window")
    }

    const name = input.name.trim()
    const baseUrl = pairing?.baseUrl ?? input.baseUrl.trim()
    if (!name || !baseUrl) throw new Error(t("folderSelection.servers.dialog.errorRequired"))
    // Remote Control certificates are publicly trusted. Skipping verification would later route Tauri through the
    // TLS proxy, whose incognito window store does not keep the paired device cookie.
    const skipTlsVerify = pairing ? false : input.skipTlsVerify

    const probe = await serverApi.probeRemoteServer({ baseUrl, skipTlsVerify })
    if (!probe.ok) throw new Error(probe.error || t("folderSelection.servers.dialog.errorConnect"))

    const profile = await saveRemoteServerProfile({
      // Pairing a saved server again reuses its window storage instead of adding a duplicate.
      id: input.id ?? (pairing ? remoteServers().find((server) => server.baseUrl === probe.normalizedUrl)?.id : undefined),
      name,
      baseUrl: probe.normalizedUrl,
      skipTlsVerify,
    })

    if (openWindow) {
      const proxySession =
        isTauriHost() && profile.skipTlsVerify && profile.baseUrl.startsWith("https://")
          ? await serverApi.createRemoteProxySession({ baseUrl: profile.baseUrl, skipTlsVerify: true })
          : undefined

      try {
        await openRemoteServerWindow(profile, pairing?.entryUrl ?? proxySession?.windowUrl, proxySession?.sessionId, windowOptions)
      } catch (error) {
        if (proxySession) void serverApi.deleteRemoteProxySession(proxySession.sessionId).catch(() => {})
        throw error
      }
      await markRemoteServerConnected(profile.id)
    }

    return profile
  }

  const connectSavedServer = async (id: string) => {
    if (!canOpenRemoteWindows() || connectingServerId()) return
    const target = remoteServers().find((server) => server.id === id)
    if (!target) return

    setConnectingServerId(id)
    try {
      await saveServer(target, true)
    } catch (error) {
      showAlertDialog(error instanceof Error ? error.message : String(error), {
        title: t("folderSelection.servers.errorTitle"),
        variant: "warning",
      })
    } finally {
      setConnectingServerId(null)
    }
  }

  return { remoteServers, connectingServerId, saveServer, connectSavedServer, removeRemoteServerProfile }
}
