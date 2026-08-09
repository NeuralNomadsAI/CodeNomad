import { invoke } from "@tauri-apps/api/core"
import { canOpenLocalDirectory, canUseNativeDialogs, isElectronHost, isTauriHost } from "../runtime-env"
import { getLogger } from "../logger"
import type { NativeDialogOptions } from "./types"
import { openElectronNativeDialog } from "./electron/functions"
import { openTauriNativeDialog } from "./tauri/functions"

const log = getLogger("actions")

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

export function supportsLocalDirectoryOpen(): boolean {
  return canOpenLocalDirectory()
}

export async function openLocalDirectory(path: string, repoRoot: string): Promise<boolean> {
  const directory = path.trim()
  const root = repoRoot.trim()
  if (!directory || !root || !canOpenLocalDirectory()) return false

  try {
    if (isElectronHost()) {
      const result = await window.electronAPI?.openDirectory?.(directory, root)
      return result?.ok === true
    }
    if (isTauriHost()) {
      await invoke("open_local_directory", { path: directory, repoRoot: root })
      return true
    }
  } catch (error) {
    log.error("[native] failed to open local directory", error)
  }
  return false
}
