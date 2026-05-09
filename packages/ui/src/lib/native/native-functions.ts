import { canUseNativeDialogs, isElectronHost, isTauriHost } from "../runtime-env"
import type { NativeDialogOptions } from "./types"
import { openElectronNativeDialog } from "./electron/functions"
import { openTauriNativeDialog } from "./tauri/functions"

export type { NativeDialogOptions, NativeDialogFilter, NativeDialogMode } from "./types"

function resolveNativeHandler(): ((options: NativeDialogOptions) => Promise<string | null>) | null {
  if (isElectronHost()) {
    return openElectronNativeDialog
  }
  if (isTauriHost()) {
    return openTauriNativeDialog
  }
  return null
}

export function supportsNativeDialogs(): boolean {
  return resolveNativeHandler() !== null
}

export function supportsNativeDialogsInCurrentWindow(): boolean {
  return canUseNativeDialogs()
}

async function openNativeDialog(options: NativeDialogOptions): Promise<string | null> {
  const handler = resolveNativeHandler()
  if (!handler) {
    return null
  }
  return handler(options)
}

export async function openNativeFolderDialog(options?: Omit<NativeDialogOptions, "mode">): Promise<string | null> {
  return openNativeDialog({ mode: "directory", ...(options ?? {}) })
}

export async function openNativeFileDialog(options?: Omit<NativeDialogOptions, "mode">): Promise<string | null> {
  return openNativeDialog({ mode: "file", ...(options ?? {}) })
}
