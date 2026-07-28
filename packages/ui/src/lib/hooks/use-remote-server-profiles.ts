import { createSignal } from "solid-js"
import { serverApi } from "../api-client"
import { useI18n } from "../i18n"
import { openRemoteServerWindow } from "../native/remote-window"
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

  const saveServer = async (input: RemoteServerInput, openWindow: boolean) => {
    if (openWindow && !canOpenRemoteWindows()) {
      throw new Error("Remote server windows can only be opened from a local desktop window")
    }

    const name = input.name.trim()
    const baseUrl = input.baseUrl.trim()
    if (!name || !baseUrl) throw new Error(t("folderSelection.servers.dialog.errorRequired"))

    const probe = await serverApi.probeRemoteServer({ baseUrl, skipTlsVerify: input.skipTlsVerify })
    if (!probe.ok) throw new Error(probe.error || t("folderSelection.servers.dialog.errorConnect"))

    const profile = await saveRemoteServerProfile({
      id: input.id,
      name,
      baseUrl: probe.normalizedUrl,
      skipTlsVerify: input.skipTlsVerify,
    })

    if (openWindow) {
      const proxySession =
        isTauriHost() && profile.skipTlsVerify && profile.baseUrl.startsWith("https://")
          ? await serverApi.createRemoteProxySession({ baseUrl: profile.baseUrl, skipTlsVerify: true })
          : undefined

      try {
        await openRemoteServerWindow(profile, proxySession?.windowUrl, proxySession?.sessionId)
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
