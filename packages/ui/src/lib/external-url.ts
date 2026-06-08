import { isTauriHost } from "./runtime-env"

export async function openExternalUrl(url: string, context = "ui"): Promise<boolean> {
  if (typeof window === "undefined") {
    return false
  }

  if (isTauriHost()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener")
      await openUrl(url)
      return true
    } catch (error) {
      console.warn(`[${context}] unable to open via system opener`, error)
    }
  }

  try {
    const popup = window.open(url, "_blank", "noopener,noreferrer")
    return popup !== null
  } catch (error) {
    console.warn(`[${context}] unable to open external url`, error)
    return false
  }
}
