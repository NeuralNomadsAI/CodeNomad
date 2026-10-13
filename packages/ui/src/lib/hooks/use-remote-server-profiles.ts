import { createSignal } from "solid-js"
import { serverApi } from "../api-client"
import { useI18n } from "../i18n"
import { openRemoteServerWindow } from "../native/remote-window"
import { splitPairingLink } from "../remote-pairing-link"
import { canOpenRemoteWindows, isTauriHost } from "../runtime-env"
import { showAlertDialog } from "../../stores/alerts"
import { useConfig } from "../../stores/preferences"

export type RemoteServerInput = {
  id?: string
  name: string
  baseUrl: string
  skipTlsVerify: boolean
}

export function useRemoteServerProfiles() {
  const { t } = useI18n()
  const { remoteServers, saveRemoteServerProfile, markRemoteServerConnected, removeRemoteServerProfile } = useConfig()
  const [connectingServerId, setConnectingServerId] = createSignal<string | null>(null)

  const saveServer = async (input: RemoteServerInput, requestedWindow: boolean) => {
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
        await openRemoteServerWindow(profile, pairing?.entryUrl ?? proxySession?.windowUrl, proxySession?.sessionId)
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
