import { onCleanup, onMount } from "solid-js"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useI18n } from "../i18n"
import { resolveLaunchConnectTarget } from "../launch-connect-target"
import { getLogger } from "../logger"
import { isElectronHost, isTauriHost } from "../runtime-env"
import { useRemoteServerProfiles } from "./use-remote-server-profiles"
import { showAlertDialog } from "../../stores/alerts"
import { useConfig } from "../../stores/preferences"
import { installDesktopConnectionLaunchHandler, type PendingConnection } from "../desktop-connection-queue"

/** Opens the remote windows requested with `--connect-server` through the saved-server connect flow. */
export function useDesktopConnectionLaunch(): void {
  const log = getLogger("actions")
  const { t } = useI18n()
  const { ensureLoaded, remoteServers } = useConfig()
  const { saveServer } = useRemoteServerProfiles()

  const connect = async (value: string, { interactive }: { interactive: boolean }) => {
    await ensureLoaded()
    const target = resolveLaunchConnectTarget(value, remoteServers())
    if (target.kind === "error") throw new Error(t(`folderSelection.servers.launch.error.${target.reason}`, { value: value.trim() }))
    const options = { interactive, requireLoad: true }
    if (target.kind === "saved") await saveServer(target.server, true, options)
    else await saveServer({ name: target.name, baseUrl: target.baseUrl, skipTlsVerify: false }, true, options)
  }
  const reportFailure = (message: string) => {
    showAlertDialog(message, { title: t("folderSelection.servers.errorTitle"), variant: "warning" })
  }
  const reportError = (error: unknown) => log.error("Failed to open launched server connection", error)

  onMount(() => {
    if (isElectronHost()) {
      onCleanup(installDesktopConnectionLaunchHandler(window.electronAPI, connect, reportFailure, reportError))
      return
    }
    if (!isTauriHost()) return
    let disposed = false
    let cleanup = () => {}
    void (async () => {
      let notify = () => {}
      const unlisten = await listen("desktop:connections-pending", () => notify())
      if (disposed) { unlisten(); return }
      const uninstall = installDesktopConnectionLaunchHandler({
        nextPendingConnection: () => invoke<PendingConnection | null>("desktop_launch_next_connection"),
        acknowledgePendingConnection: (target, failure, handOff) => invoke("desktop_launch_acknowledge_connection", { target, failure, handOff }),
        onPendingConnections: (callback) => { notify = callback; return () => { notify = () => {} } },
      }, connect, reportFailure, reportError)
      cleanup = () => { uninstall(); unlisten() }
    })().catch(reportError)
    onCleanup(() => { disposed = true; cleanup() })
  })
}
