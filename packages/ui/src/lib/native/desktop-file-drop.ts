import { listen } from "@tauri-apps/api/event"
import { getLogger } from "../logger"
import { runtimeEnv } from "../runtime-env"

const log = getLogger("actions")

type NativeFolderDropState = "enter" | "leave"

interface TauriFolderDropPayload {
  paths?: unknown
}

function normalizePathList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return []
  }
  return input.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function getFilePath(file: File): string | null {
  if (typeof file.path === "string" && file.path.trim().length > 0) {
    return file.path
  }
  if (runtimeEnv.host === "electron") {
    const electronPath = (window as Window & { electronAPI?: ElectronAPI }).electronAPI?.getPathForFile?.(file)
    if (typeof electronPath === "string" && electronPath.trim().length > 0) {
      return electronPath
    }
  }
  return null
}

async function resolveElectronDirectoryPaths(paths: string[]): Promise<string[]> {
  const api = (window as Window & { electronAPI?: ElectronAPI }).electronAPI
  if (!api?.getDirectoryPaths || paths.length === 0) {
    return []
  }
  try {
    return await api.getDirectoryPaths(paths)
  } catch (error) {
    log.error("[native] failed to validate dropped directory paths", error)
    return []
  }
}

export function supportsDesktopFolderDrop(): boolean {
  return runtimeEnv.platform === "desktop" && runtimeEnv.host !== "web"
}

export function containsFileDrop(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  if (!types) {
    return false
  }
  return Array.from(types).includes("Files")
}

export function extractDroppedDirectoryPaths(event: DragEvent): string[] {
  const dataTransfer = event.dataTransfer
  if (!dataTransfer) {
    return []
  }

  const directoryHints = new Set<string>()
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== "file") {
      continue
    }
    const entry = item.webkitGetAsEntry?.()
    if (!entry?.isDirectory) {
      continue
    }
    const file = item.getAsFile()
    const filePath = file ? getFilePath(file) : null
    if (filePath) {
      directoryHints.add(filePath)
    }
  }

  const paths = new Set<string>()
  for (const file of Array.from(dataTransfer.files ?? [])) {
    const filePath = getFilePath(file)
    if (!filePath) {
      continue
    }
    if (directoryHints.size > 0 && !directoryHints.has(filePath)) {
      continue
    }
    paths.add(filePath)
  }

  return Array.from(paths)
}

export async function normalizeDroppedDirectoryPaths(paths: string[]): Promise<string[]> {
  const uniquePaths = Array.from(new Set(paths.filter((path) => typeof path === "string" && path.trim().length > 0)))
  if (uniquePaths.length === 0) {
    return []
  }
  if (runtimeEnv.host === "electron") {
    return resolveElectronDirectoryPaths(uniquePaths)
  }
  return uniquePaths
}

export async function listenForNativeFolderDrops(onDrop: (paths: string[]) => void): Promise<() => void> {
  if (runtimeEnv.host !== "tauri") {
    return () => {}
  }

  try {
    const unlisten = await listen("desktop:folder-drop", (event) => {
      const payload = (event.payload ?? {}) as TauriFolderDropPayload
      const paths = normalizePathList(payload.paths)
      if (paths.length > 0) {
        onDrop(paths)
      }
    })
    return () => {
      unlisten()
    }
  } catch (error) {
    log.error("[native] failed to listen for folder-drop event", error)
    return () => {}
  }
}

export async function listenForNativeFolderDropState(onState: (state: NativeFolderDropState) => void): Promise<() => void> {
  if (runtimeEnv.host !== "tauri") {
    return () => {}
  }

  try {
    const [unlistenEnter, unlistenLeave] = await Promise.all([
      listen("desktop:folder-drag-enter", () => onState("enter")),
      listen("desktop:folder-drag-leave", () => onState("leave")),
    ])
    return () => {
      unlistenEnter()
      unlistenLeave()
    }
  } catch (error) {
    log.error("[native] failed to listen for folder-drop state", error)
    return () => {}
  }
}
