import { runtimeEnv } from "../runtime-env"
import { serverApi } from "../api-client"
import { getServerMeta } from "../server-meta"
import type { NativeDialogOptions } from "./types"
import { openElectronNativeDialog } from "./electron/functions"
import { openTauriNativeDialog } from "./tauri/functions"

export type { NativeDialogOptions, NativeDialogFilter, NativeDialogMode } from "./types"

function resolveNativeHandler(): ((options: NativeDialogOptions) => Promise<string | null>) | null {
  switch (runtimeEnv.host) {
    case "electron":
      return openElectronNativeDialog
    case "tauri":
      return openTauriNativeDialog
    default:
      return null
  }
}

/**
 * Synchronously checks if desktop native dialogs are supported (Electron/Tauri).
 * Does NOT check server-side support. Use `supportsNativeDialogsAsync` for full check.
 */
export function supportsNativeDialogs(): boolean {
  return resolveNativeHandler() !== null
}

/**
 * Asynchronously checks if native dialogs are supported.
 * Includes desktop handlers (Electron/Tauri) and server-side support for local web.
 */
export async function supportsNativeDialogsAsync(): Promise<boolean> {
  if (resolveNativeHandler() !== null) {
    return true
  }
  if (runtimeEnv.host === "web") {
    return checkServerLocalDialogSupport()
  }
  return false
}

let serverLocalModeCache: boolean | null = null

/**
 * Returns true when the server is running locally and supports native OS dialogs.
 * This is an async check that caches the result.
 */
export async function checkServerLocalDialogSupport(): Promise<boolean> {
  if (serverLocalModeCache !== null) {
    return serverLocalModeCache
  }
  try {
    const meta = await getServerMeta()
    serverLocalModeCache = meta.listeningMode === "local"
    return serverLocalModeCache
  } catch {
    serverLocalModeCache = false
    return false
  }
}

/**
 * Opens a native folder dialog via the server's OS integration.
 * Only works when the server is running locally (listeningMode === "local").
 */
async function openServerNativeFolderDialog(options?: Omit<NativeDialogOptions, "mode">): Promise<string | null> {
  try {
    const result = await serverApi.pickFolder({
      title: options?.title,
      defaultPath: options?.defaultPath,
    })
    return result.path
  } catch {
    return null
  }
}

async function openNativeDialog(options: NativeDialogOptions): Promise<string | null> {
  const handler = resolveNativeHandler()
  if (!handler) {
    return null
  }
  return handler(options)
}

export async function openNativeFolderDialog(options?: Omit<NativeDialogOptions, "mode">): Promise<string | null> {
  // First, try the desktop host handlers (Electron/Tauri)
  const handler = resolveNativeHandler()
  if (handler) {
    return handler({ mode: "directory", ...(options ?? {}) })
  }

  // For web host, check if server is running locally and use server-side native dialog
  if (runtimeEnv.host === "web") {
    const isLocal = await checkServerLocalDialogSupport()
    if (isLocal) {
      return openServerNativeFolderDialog(options)
    }
  }

  return null
}

export async function openNativeFileDialog(options?: Omit<NativeDialogOptions, "mode">): Promise<string | null> {
  return openNativeDialog({ mode: "file", ...(options ?? {}) })
}
