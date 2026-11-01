import { isNativeApplicationWindow, isTauriHost } from "./runtime-env"

export async function openExternalUrl(url: string, context = "ui", current: () => boolean = () => true): Promise<boolean> {
  if (typeof window === "undefined" || !current()) {
    return false
  }

  // Application and Preferences windows hold the host's opener command; remote windows do not.
  if (isTauriHost() && isNativeApplicationWindow()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      if (!current()) return false
      await invoke("open_external_url", { url })
      return true
    } catch {
      console.warn(`[${context}] unable to open via system opener`)
      return false
    }
  }

  try {
    // noopener deliberately returns null even when the browsing context opens.
    window.open(url, "_blank", "noopener,noreferrer")
    return true
  } catch {
    console.warn(`[${context}] unable to open external url`)
    return false
  }
}
