export {}

import type { LoggerControls } from "../lib/logger"

declare global {
  interface ElectronDialogFilter {
    name?: string
    extensions: string[]
  }

  interface ElectronDialogOptions {
    mode: "directory" | "file"
    title?: string
    defaultPath?: string
    filters?: ElectronDialogFilter[]
  }

  interface ElectronDialogResult {
    canceled?: boolean
    paths?: string[]
    path?: string | null
  }

  interface ElectronAPI {
    onCliStatus?: (callback: (data: unknown) => void) => () => void
    onCliError?: (callback: (data: unknown) => void) => () => void
    getCliStatus?: () => Promise<unknown>
    restartCli?: () => Promise<unknown>
    openDialog?: (options: ElectronDialogOptions) => Promise<ElectronDialogResult>
    getDirectoryPaths?: (paths: string[]) => Promise<string[]>
    getPathForFile?: (file: File) => string | null
    requestMicrophoneAccess?: () => Promise<{ granted: boolean }>
    setWakeLock?: (enabled: boolean) => Promise<{ enabled: boolean }>

    showNotification?: (payload: { title: string; body: string }) => Promise<{ ok: boolean; reason?: string }>
  }

  interface File {
    path?: string
  }

  interface FileSystemEntry {
    isDirectory: boolean
    isFile: boolean
  }

  interface DataTransferItem {
    webkitGetAsEntry?: () => FileSystemEntry | null
  }

  interface TauriBridge {
    core?: {
      invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>
    }
  }

  interface Window {
     __CODENOMAD_API_BASE__?: string
     __CODENOMAD_EVENTS_URL__?: string
     electronAPI?: ElectronAPI
     __TAURI__?: TauriBridge
     codenomadLogger?: LoggerControls
   }
 }
