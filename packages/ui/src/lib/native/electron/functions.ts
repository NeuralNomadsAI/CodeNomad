import type { NativeDialogOptions } from "../native-functions"
import { getLogger } from "../../logger"
const log = getLogger("actions")


interface ElectronDialogResult {
  canceled?: boolean
  paths?: string[]
  path?: string | null
}

interface ElectronAPI {
  openDialog?: (options: NativeDialogOptions) => Promise<ElectronDialogResult>
}

function coerceFirstPath(result?: ElectronDialogResult | null): string | null {
  if (!result || result.canceled) {
    return null
  }
  const paths = Array.isArray(result.paths) ? result.paths : result.path ? [result.path] : []
  if (paths.length === 0) {
    return null
  }
  return paths[0] ?? null
}

export async function openElectronNativeDialog(options: NativeDialogOptions): Promise<string | null> {
  if (typeof window === "undefined") {
    return null
  }
  const api = (window as Window & { electronAPI?: ElectronAPI }).electronAPI
  if (!api?.openDialog) {
    return null
  }
  try {
    const result = await api.openDialog(options)
    return coerceFirstPath(result)
  } catch (error) {
    log.error("[native] electron dialog failed", error)
    return null
  }
}
