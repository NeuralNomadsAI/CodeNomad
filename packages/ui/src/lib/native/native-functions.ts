import { canUseNativeDialogs, isElectronHost, isTauriHost } from "../runtime-env"
import type { NativeDialogOptions } from "./types"
import { openElectronNativeDialog } from "./electron/functions"
import { openTauriNativeDialog } from "./tauri/functions"

export type { NativeDialogOptions, NativeDialogFilter, NativeDialogMode } from "./types"

type NativeDialogResult = string | string[] | null

function resolveNativeHandler(): ((options: NativeDialogOptions) => Promise<NativeDialogResult>) | null {
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

async function openNativeDialog(options: NativeDialogOptions): Promise<NativeDialogResult> {
  const handler = resolveNativeHandler()
  if (!handler) {
    return null
  }
  return handler(options)
}

export async function openNativeFolderDialog(options?: Omit<NativeDialogOptions, "mode">): Promise<string | null> {
  const result = await openNativeDialog({ mode: "directory", ...(options ?? {}) })
  return Array.isArray(result) ? result[0] ?? null : result
}

export async function openNativeFileDialog(options?: Omit<NativeDialogOptions, "mode">): Promise<string | null> {
  const result = await openNativeDialog({ mode: "file", ...(options ?? {}) })
  return Array.isArray(result) ? result[0] ?? null : result
}

export async function openNativeFileDialogs(options?: Omit<NativeDialogOptions, "mode" | "multiple">): Promise<string[]> {
  const result = await openNativeDialog({ mode: "file", multiple: true, ...(options ?? {}) })
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}
