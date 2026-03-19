import { isTauriHost } from "./runtime-env"

export async function openExternalUrl(url: string, context = "ui"): Promise<void> {
  if (typeof window === "undefined") {
    return
  }

  if (isTauriHost()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener")
      await openUrl(url)
      return
    } catch (error) {
      console.warn(`[${context}] unable to open via system opener`, error)
    }
  }

  try {
    window.open(url, "_blank", "noopener,noreferrer")
  } catch (error) {
    console.warn(`[${context}] unable to open external url`, error)
  }
}
