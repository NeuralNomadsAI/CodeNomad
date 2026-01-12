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
    openDialog?: (options: ElectronDialogOptions) => Promise<ElectronDialogResult>
  }

  interface TauriDialogModule {
    open?: (options: Record<string, unknown>) => Promise<string | string[] | null>
    save?: (options: Record<string, unknown>) => Promise<string | null>
  }

  interface TauriBridge {
    invoke?: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>
    dialog?: TauriDialogModule
  }

  interface Window {
     __ERA_CODE_API_BASE__?: string
     __ERA_CODE_EVENTS_URL__?: string
     electronAPI?: ElectronAPI
     __TAURI__?: TauriBridge
     eraCodeLogger?: LoggerControls
   }
 }


