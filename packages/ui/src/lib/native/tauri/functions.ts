import { open } from "@tauri-apps/plugin-dialog"
import type { NativeDialogOptions } from "../native-functions"
import { getLogger } from "../../logger"
const log = getLogger("actions")

export async function openTauriNativeDialog(options: NativeDialogOptions): Promise<string | null> {
  if (typeof window === "undefined") {
    return null
  }

  try {
    const response = await open({
      title: options.title,
      defaultPath: options.defaultPath,
      directory: options.mode === "directory",
      multiple: false,
      filters: options.filters?.map((filter) => ({
        name: filter.name ?? "Files",
        extensions: filter.extensions,
      })),
    })

    if (!response) {
      return null
    }

    if (Array.isArray(response)) {
      return response[0] ?? null
    }

    return response
  } catch (error) {
    log.error("[native] tauri dialog failed", error)
    return null
  }
}
