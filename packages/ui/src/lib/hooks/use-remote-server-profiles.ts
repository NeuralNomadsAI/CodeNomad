import { createSignal } from "solid-js"
import { serverApi } from "../api-client"
import { useI18n } from "../i18n"
import { openRemoteServerWindow, type RemoteWindowOpenOptions } from "../native/remote-window"
import { splitPairingLink } from "../remote-pairing-link"
import { codeNomadLinkName } from "../codenomad-link"
import { canOpenRemoteWindows, isTauriHost } from "../runtime-env"
import { showAlertDialog } from "../../stores/alerts"
import { useConfig } from "../../stores/preferences"
import { closeRemoteProjectTabsForServer } from "../../stores/remote-project-tabs"
import { openRemoteProject, opensRemoteProjectTab } from "../../stores/remote-project-open"
import { activeBlankTabId } from "../../stores/app-tabs"
import type { RemoteServerProfile } from "../../../../server/src/api-types"

export type RemoteServerInput = {
  id?: string
  name: string
  baseUrl: string
  skipTlsVerify: boolean
}

/** A failed probe, with the server's reason code (`tls_error` for a certificate that failed the check). */
export class RemoteServerProbeError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = "RemoteServerProbeError"
  }
}

export function useRemoteServerProfiles() {
  const { t } = useI18n()
  const { remoteServers, saveRemoteServerProfile, markRemoteServerConnected, removeRemoteServerProfile } = useConfig()
  const [connectingServerId, setConnectingServerId] = createSignal<string | null>(null)

  /** Probes and saves a server; a pairing link's single-use entry is returned, never saved. */
  const saveProfile = async (input: RemoteServerInput) => {
    const pairing = splitPairingLink(input.baseUrl)
    const baseUrl = pairing?.baseUrl ?? input.baseUrl.trim()
    if (!baseUrl) throw new Error(t("folderSelection.servers.dialog.errorRequired"))
    // Nothing secret is ever saved with a server: an address carrying credentials is refused.
    if (!pairing && /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(baseUrl)) throw new Error(t("folderSelection.servers.dialog.errorConnect"))
    // The name is optional: a server without one reads as its host name.
    const name = input.name.trim() || codeNomadLinkName(baseUrl)
    // Remote Control certificates are publicly trusted. Skipping verification would later route Tauri through the
    // TLS proxy, whose incognito window store does not keep the paired device cookie.
    const skipTlsVerify = pairing ? false : input.skipTlsVerify

    // Renaming a saved server keeps its address: it needs no probe, even while the server is offline.
    const saved = input.id ? remoteServers().find((server) => server.id === input.id) : undefined
    if (saved && !pairing && saved.baseUrl === baseUrl && saved.skipTlsVerify === skipTlsVerify) {
      return { profile: await saveRemoteServerProfile({ id: saved.id, name, baseUrl, skipTlsVerify }), entryUrl: undefined }
    }

    const probe = await serverApi.probeRemoteServer({ baseUrl, skipTlsVerify })
    if (!probe.ok) throw new RemoteServerProbeError(probe.error || t("folderSelection.servers.dialog.errorConnect"), probe.errorCode)
    const existing = remoteServers().find((server) => server.baseUrl === probe.normalizedUrl)

    const profile = await saveRemoteServerProfile({
      // Adding or pairing a saved server again reuses its window storage instead of adding a duplicate.
      id: input.id ?? existing?.id,
      name: input.name.trim() || existing?.name || name,
      baseUrl: probe.normalizedUrl,
      skipTlsVerify,
    })
    return { profile, entryUrl: pairing?.entryUrl }
  }

  const saveServer = async (input: RemoteServerInput, requestedWindow: boolean, windowOptions: RemoteWindowOpenOptions = {}, entryUrl?: string) => {
    const pairing = splitPairingLink(input.baseUrl)
    const openWindow = requestedWindow
    if (openWindow && !canOpenRemoteWindows()) {
      throw new Error("Remote server windows can only be opened from a local desktop window")
    }

    const { profile } = await saveProfile(input)

    if (openWindow) {
      const proxySession =
        isTauriHost() && profile.skipTlsVerify && profile.baseUrl.startsWith("https://")
          ? await serverApi.createRemoteProxySession({ baseUrl: profile.baseUrl, skipTlsVerify: true })
          : undefined

      try {
        let target = pairing?.entryUrl ?? entryUrl ?? proxySession?.windowUrl
        if (proxySession && entryUrl) {
          const bootstrap = new URL(proxySession.windowUrl), entry = new URL(entryUrl)
          bootstrap.searchParams.set("returnTo", `${entry.pathname}${entry.search}`)
          target = bootstrap.toString()
        }
        await openRemoteServerWindow(profile, target, proxySession?.sessionId, windowOptions)
      } catch (error) {
        if (proxySession) void serverApi.deleteRemoteProxySession(proxySession.sessionId).catch(() => {})
        throw error
      }
      await markRemoteServerConnected(profile.id)
    }

    return profile
  }

  const connectSavedServer = async (id: string, entryUrl?: string) => {
    if (!canOpenRemoteWindows() || connectingServerId()) return
    const target = remoteServers().find((server) => server.id === id)
    if (!target) return

    setConnectingServerId(id)
    try {
      await saveServer(target, true, {}, entryUrl)
    } catch (error) {
      showAlertDialog(error instanceof Error ? error.message : String(error), {
        title: t("folderSelection.servers.errorTitle"),
        variant: "warning",
      })
    } finally {
      setConnectingServerId(null)
    }
  }

  /** A saved server opens a project tab, or its own window when it cannot (unverified certificate, no tabs here). */
  const openServer = (profile: RemoteServerProfile, entryUrl?: string, blankId: string | null = activeBlankTabId() ?? null) => {
    if (opensRemoteProjectTab(profile)) {
      openRemoteProject(profile.id, entryUrl ? { entryUrl } : {}, blankId)
      void markRemoteServerConnected(profile.id).catch(() => {})
    } else {
      void connectSavedServer(profile.id, entryUrl)
    }
  }

  /** Saves a server; backend browsing credentials stay with the local server. */
  const submitServer = async (input: RemoteServerInput, open: boolean) => {
    const blankId = activeBlankTabId() ?? null
    const { profile, entryUrl } = await saveProfile(input)
    if (entryUrl) await serverApi.connectRemoteServer(profile.id, { pairingLink: entryUrl })
    if (open) openServer(profile, entryUrl, blankId)
    return profile
  }

  // A removed server's project tabs close with it.
  const removeServer = async (id: string) => {
    try { await serverApi.forgetRemoteServer(id) } catch {
      showAlertDialog(t("folderSelection.servers.dialog.errorConnect"), { variant: "warning" })
      return
    }
    closeRemoteProjectTabsForServer(id)
    removeRemoteServerProfile(id)
  }

  return { remoteServers, connectingServerId, saveServer, submitServer, openServer, removeRemoteServerProfile: removeServer }
}
