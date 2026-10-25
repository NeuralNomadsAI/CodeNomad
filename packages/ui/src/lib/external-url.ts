import { isNativeApplicationWindow, isTauriHost } from "./runtime-env"

export async function openExternalUrl(url: string, context = "ui"): Promise<boolean> {
  if (typeof window === "undefined") {
    return false
  }

  // Application and Preferences windows hold the host's opener command; remote windows do not.
  if (isTauriHost() && isNativeApplicationWindow()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("open_external_url", { url })
      return true
    } catch (error) {
      console.warn(`[${context}] unable to open via system opener`, error)
      return false
    }
  }

  try {
    // noopener deliberately returns null even when the browsing context opens.
    window.open(url, "_blank", "noopener,noreferrer")
    return true
  } catch (error) {
    console.warn(`[${context}] unable to open external url`, error)
    return false
  }
}
