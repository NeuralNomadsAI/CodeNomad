import { isElectronHost, isTauriHost } from "./runtime-env"

export async function openExternalUrl(url: string, context = "ui"): Promise<boolean> {
  if (typeof window === "undefined") {
    return false
  }

  const electronApi = (window as Window & { electronAPI?: ElectronAPI }).electronAPI

  try {
    if (isElectronHost()) {
      const result = await electronApi?.openExternalUrl?.(url)
      if (result?.ok !== false) {
        return true
      }
      console.warn(`[${context}] unable to open via electron shell`, result?.reason)
    }

    if (isTauriHost()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener")
      await openUrl(url)
      return true
    }
  } catch (error) {
    console.warn(`[${context}] unable to open via system opener`, error)
    if (isTauriHost()) {
      return false
    }
  }

  try {
    const opened = window.open(url, "_blank", "noopener,noreferrer")
    return opened !== null
  } catch (error) {
    console.warn(`[${context}] unable to open external url`, error)
    return false
  }
}
