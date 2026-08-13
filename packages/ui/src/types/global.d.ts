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
    multiple?: boolean
  }

  interface ElectronDialogResult {
    canceled?: boolean
    paths?: string[]
    path?: string | null
  }

  interface ElectronClientStateLoadResult {
    isPrimary: boolean
    restoreEnabled: boolean
    snapshot: unknown | null
  }

  interface ElectronAPI {
    onCliStatus?: (callback: (data: unknown) => void) => () => void
    onCliError?: (callback: (data: unknown) => void) => () => void
    getCliStatus?: () => Promise<unknown>
    restartCli?: () => Promise<unknown>
    openDialog?: (options: ElectronDialogOptions) => Promise<ElectronDialogResult>
    getDirectoryPaths?: (paths: string[]) => Promise<string[]>
    openWorkspaceTarget?: (payload: {
      target: "default" | "reveal" | "terminal" | "editor"
      instanceId: string
      worktreeSlug: string
      path?: string
      editor?: "vscode" | "cursor" | "zed" | "vscodium"
    }) => Promise<{ ok: true }>
    setWorkspaceMenuEnabled?: (enabled: boolean) => Promise<{ ok: true }>
    onMenuAction?: (callback: (action: string) => void) => () => void
    getPathForFile?: (file: File) => string | null
    requestMicrophoneAccess?: () => Promise<{ granted: boolean }>
    setWakeLock?: (enabled: boolean) => Promise<{ enabled: boolean }>
    claimClientStateAccess?: (accessToken: string) => Promise<boolean>
    loadClientState?: (accessToken: string) => Promise<ElectronClientStateLoadResult>
    saveClientState?: (accessToken: string, snapshot: unknown) => Promise<boolean>
    setClientStateRestoreEnabled?: (accessToken: string, enabled: boolean) => Promise<boolean>
    clearClientState?: (accessToken: string) => Promise<boolean>

    showNotification?: (payload: { title: string; body: string }) => Promise<{ ok: boolean; reason?: string }>
    openRemoteWindow?: (payload: {
      id: string
      name: string
      baseUrl: string
      entryUrl?: string
      proxySessionId?: string
      skipTlsVerify: boolean
    }) => Promise<{ ok: boolean }>
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
       __CODENOMAD_RUNTIME_HOST__?: "electron" | "tauri" | "web"
       __CODENOMAD_WINDOW_CONTEXT__?: "local" | "remote"
       __CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__?: () => Promise<void>
       electronAPI?: ElectronAPI
      __TAURI__?: TauriBridge
      codenomadLogger?: LoggerControls
   }
 }
