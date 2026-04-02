import { invoke } from "@tauri-apps/api/core"
import type { RemoteServerProfile } from "../../../../server/src/api-types"
import { runtimeEnv } from "../runtime-env"

export interface RemoteWindowOpenPayload {
  id: string
  name: string
  baseUrl: string
  skipTlsVerify: boolean
}

export async function openRemoteServerWindow(profile: Pick<RemoteServerProfile, "id" | "name" | "baseUrl" | "skipTlsVerify">): Promise<void> {
  const payload: RemoteWindowOpenPayload = {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    skipTlsVerify: profile.skipTlsVerify,
  }

  if (runtimeEnv.host === "electron") {
    const api = (window as Window & { electronAPI?: ElectronAPI }).electronAPI
    if (typeof api?.openRemoteWindow === "function") {
      await api.openRemoteWindow(payload)
      return
    }
  }

  if (runtimeEnv.host === "tauri") {
    await invoke("open_remote_window", { payload })
    return
  }

  window.open(profile.baseUrl, "_blank", "noopener,noreferrer")
}
