export {}

import type { LoggerControls } from "../lib/logger"
import type { LocationRef } from "@opencode-ai/client"
import type { SettingsSectionId } from "../stores/settings-screen"

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
    partitionProtocolVersion?: 1
  }

  interface ClientStatePartitionCommit {
    protocolVersion: 1
    snapshot: unknown
    partitions: Record<string, string>
    partitionKeys: string[]
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
    newWindow?: () => Promise<{ ok: true }>
    nextPendingFolder?: () => Promise<string | null>
    acknowledgePendingFolder?: (folder: string, opened: boolean) => Promise<{ ok: true }>
    onPendingFolders?: (callback: () => void) => () => void
    onMenuAction?: (callback: (action: string) => void) => () => void
    showTitlebarMenu?: (menu: "file" | "edit" | "view" | "window" | "help", x: number, y: number) => Promise<unknown>
    getPathForFile?: (file: File) => string | null
    requestMicrophoneAccess?: () => Promise<{ granted: boolean }>
    setWakeLock?: (enabled: boolean) => Promise<{ enabled: boolean }>
    getDeveloperMode?: () => Promise<{ enabled: boolean; active: boolean }>
    setDeveloperMode?: (enabled: boolean) => Promise<{ enabled: boolean; active: boolean }>
    claimClientStateAccess?: (accessToken: string) => Promise<boolean>
    loadClientState?: (accessToken: string) => Promise<ElectronClientStateLoadResult>
    saveClientState?: (accessToken: string, snapshot: unknown) => Promise<boolean>
    commitClientStatePartitions?: (accessToken: string, payload: ClientStatePartitionCommit) => Promise<boolean>
    loadClientStatePartition?: (accessToken: string, key: string) => Promise<string | null>
    setClientStateRestoreEnabled?: (accessToken: string, enabled: boolean) => Promise<boolean>
    clearClientState?: (accessToken: string) => Promise<boolean>
    registerBrowserTarget?: (payload: { sessionId: string; registrationId: string; guestWebContentsId: number }) => Promise<{ ok: true }>
    unregisterBrowserTarget?: (registrationId: string) => Promise<{ ok: true }>
    claimBrowserOpen?: (requestID: string) => Promise<boolean>
    onBrowserOpenRequest?: (callback: (payload: { sessionID: string; url: string; requestID: string }) => void) => () => void

    showNotification?: (payload: { title: string; body: string }) => Promise<{ ok: boolean; reason?: string }>
    openRemoteWindow?: (payload: {
      id: string
      name: string
      baseUrl: string
      entryUrl?: string
      proxySessionId?: string
      skipTlsVerify: boolean
    }) => Promise<{ ok: boolean }>
    openPreferences?: (section: SettingsSectionId, context?: { instanceId?: string; location?: LocationRef }) => Promise<unknown>
    getPreferencesRequest?: () => Promise<unknown>
    getPreferencesSection?: () => Promise<unknown>
    preferencesReady?: () => Promise<unknown>
    acceptPreferencesRequest?: (request: unknown) => Promise<unknown>
    resolvePreferencesTransition?: (id: number, approved: boolean) => Promise<unknown>
    onPreferencesSection?: (callback: (request: unknown) => void) => () => void
    onPreferencesCloseRequested?: (callback: () => void) => () => void
    onPreferencesTransitionRequested?: (callback: (value: unknown) => void) => () => void
    minimizeWindow?: () => Promise<unknown>
    toggleMaximizeWindow?: () => Promise<unknown>
    closeWindow?: () => Promise<unknown>
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
    event?: {
      listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>
    }
  }

  interface Window {
      __CODENOMAD_API_BASE__?: string
      __CODENOMAD_EVENTS_URL__?: string
       __CODENOMAD_RUNTIME_HOST__?: "electron" | "tauri" | "web"
       __CODENOMAD_WINDOW_CONTEXT__?: "local" | "remote" | "preferences"
       readonly __CODENOMAD_WINDOW_ID__?: string | null
       __CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__?: () => Promise<void>
       electronAPI?: ElectronAPI
      __TAURI__?: TauriBridge
      codenomadLogger?: LoggerControls
   }
 }
