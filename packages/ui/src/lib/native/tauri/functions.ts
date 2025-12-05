import type { NativeDialogOptions } from "../native-functions"
import { getLogger } from "../../logger"
const log = getLogger("actions")


interface TauriDialogModule {
  open?: (
    options: {
      title?: string
      defaultPath?: string
      filters?: { name?: string; extensions: string[] }[]
      directory?: boolean
      multiple?: boolean
    },
  ) => Promise<string | string[] | null>
}

interface TauriBridge {
  dialog?: TauriDialogModule
}

export async function openTauriNativeDialog(options: NativeDialogOptions): Promise<string | null> {
  if (typeof window === "undefined") {
    return null
  }

  const tauriBridge = (window as Window & { __TAURI__?: TauriBridge }).__TAURI__
  const dialogApi = tauriBridge?.dialog
  if (!dialogApi?.open) {
    return null
  }

  try {
    const response = await dialogApi.open({
      title: options.title,
      defaultPath: options.defaultPath,
      directory: options.mode === "directory",
      multiple: false,
      filters: options.filters?.map((filter) => ({
        name: filter.name,
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
