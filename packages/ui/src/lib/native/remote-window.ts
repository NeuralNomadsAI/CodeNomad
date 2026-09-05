import { invoke } from "@tauri-apps/api/core"
import type { RemoteServerProfile } from "../../../../server/src/api-types"
import { showConfirmDialog } from "../../stores/alerts"
import { tGlobal } from "../i18n"
import { canOpenRemoteWindows, isElectronHost, isTauriHost } from "../runtime-env"

export interface RemoteWindowOpenPayload {
  id: string
  name: string
  baseUrl: string
  entryUrl?: string
  proxySessionId?: string
  skipTlsVerify: boolean
}

export async function openRemoteServerWindow(
  profile: Pick<RemoteServerProfile, "id" | "name" | "baseUrl" | "skipTlsVerify">,
  entryUrl?: string,
  proxySessionId?: string,
): Promise<void> {
  if (!canOpenRemoteWindows()) {
    throw new Error("Remote server windows can only be opened from a local desktop window")
  }

  const payload: RemoteWindowOpenPayload = {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    entryUrl,
    proxySessionId,
    skipTlsVerify: profile.skipTlsVerify,
  }

  if (isElectronHost()) {
    const api = (window as Window & { electronAPI?: ElectronAPI }).electronAPI
    if (typeof api?.openRemoteWindow === "function") {
      await api.openRemoteWindow(payload)
      return
    }
  }

  if (isTauriHost()) {
    const requiresLocalCertificate =
      proxySessionId !== undefined && (entryUrl ?? profile.baseUrl).startsWith("https://")

    if (requiresLocalCertificate) {
      const needsInstall = await invoke<boolean>("needs_local_certificate_install")
      if (needsInstall) {
        const accepted = await showConfirmDialog(
          tGlobal("folderSelection.servers.certificateInstall.confirmMessage"),
          {
            title: tGlobal("folderSelection.servers.certificateInstall.title"),
            variant: "warning",
            confirmLabel: tGlobal("folderSelection.servers.certificateInstall.confirmLabel"),
            cancelLabel: tGlobal("folderSelection.servers.certificateInstall.cancelLabel"),
          },
        )

        if (!accepted) {
          throw new Error(tGlobal("folderSelection.servers.certificateInstall.cancelled"))
        }
      }
    }

    await invoke("open_remote_window", { payload })
    return
  }

  window.open(profile.baseUrl, "_blank", "noopener,noreferrer")
}
