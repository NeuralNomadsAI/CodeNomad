import { invoke } from "@tauri-apps/api/core"
import { isLocalWindow, isTauriHost } from "../runtime-env"
import { getLogger } from "../logger"

interface ClipboardFile {
  name: string
  size: number
  mime: string
  data: string | null
}

// Called only from the composer's no-File paste path. Never poll the clipboard
// or let a synthetic event/remote renderer request native clipboard access.
export function readClipboardAttachments(event: ClipboardEvent): Promise<File[]> | null {
  if (!event.isTrusted || !isTauriHost() || !isLocalWindow() || !/Linux/i.test(navigator.userAgent)) return null
  return invoke<ClipboardFile[]>("read_clipboard_attachments").then(entries => {
    return entries.map(entry => {
      const bytes = entry.data === null ? new Uint8Array() : Uint8Array.from(atob(entry.data), char => char.charCodeAt(0))
      const file = new File([bytes], entry.name, { type: entry.mime })
      // Preserve native metadata for the shared pre-read size/count checks and
      // report unreadable files through its existing localized rejection UI.
      Object.defineProperty(file, "size", { value: entry.size })
      if (entry.data === null) file.arrayBuffer = async () => { throw new Error("Clipboard file could not be read") }
      return file
    })
  }).catch(error => {
    getLogger("actions").error("[native] clipboard attachment read failed", error)
    return []
  })
}
