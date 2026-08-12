import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isLocalWindow, isMobilePlatform, isTauriHost } from "../runtime-env"
const LEGACY_WEB_KEYS = ["codenomad-client-snapshot-v1", "codenomad-client-restore-enabled-v1"]
export type NativeClientStateLoadResult = {
  isPrimary: boolean
  restoreEnabled: boolean
  snapshot: unknown | null
}
const SECONDARY_CLIENT_STATE: NativeClientStateLoadResult = { isPrimary: false, restoreEnabled: false, snapshot: null }
const accessToken = (() => {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
})()
let nativeAccessClaimed = false
const electronApi = () => (window as Window & { electronAPI?: ElectronAPI }).electronAPI
function dispatchNative<T>(electronOperation: (api: ElectronAPI | undefined) => Promise<T> | undefined, command: string, args: Record<string, unknown> = {}): Promise<T> | undefined {
  if (isElectronHost()) return electronOperation(electronApi())
  if (isTauriHost()) return invoke<T>(command, { accessToken, ...args })
}
async function claimNativeClientStateAccess(): Promise<boolean> {
  if (!isLocalWindow()) return false
  try {
    const result = await dispatchNative<boolean | void>((api) => api?.claimClientStateAccess?.(accessToken), "client_state_claim_access")
    nativeAccessClaimed = isTauriHost() || result === true
  } catch {
    nativeAccessClaimed = false
  }
  return nativeAccessClaimed
}
export async function loadNativeClientState(): Promise<NativeClientStateLoadResult> {
  if (isElectronHost() || isTauriHost()) {
    if (!await claimNativeClientStateAccess()) return SECONDARY_CLIENT_STATE
    return await dispatchNative((api) => api?.loadClientState?.(accessToken), "client_state_load") ?? SECONDARY_CLIENT_STATE
  }
  try {
    for (const key of LEGACY_WEB_KEYS) window.localStorage.removeItem(key)
  } catch {}
  return SECONDARY_CLIENT_STATE
}
async function mutateNativeClientState(electronOperation: (api: ElectronAPI) => Promise<boolean> | undefined, command: string, args: Record<string, unknown> = {}): Promise<boolean> {
  if (!nativeAccessClaimed) return false
  return await dispatchNative((api) => api && electronOperation(api), command, args) ?? false
}
export const saveNativeClientState = (snapshot: unknown): Promise<boolean> =>
  mutateNativeClientState((api) => api.saveClientState?.(accessToken, snapshot), "client_state_save", { snapshot })
export const setNativeRestoreEnabled = (enabled: boolean): Promise<boolean> =>
  mutateNativeClientState((api) => api.setClientStateRestoreEnabled?.(accessToken, enabled), "client_state_set_restore_enabled", { enabled })
export const clearNativeClientState = (): Promise<boolean> =>
  mutateNativeClientState((api) => api.clearClientState?.(accessToken), "client_state_clear")
export async function openNativeWorktreeInFileManager(rootDirectory: string, registeredDirectory: string, targetDirectory: string): Promise<void> {
  if (isMobilePlatform() || !isLocalWindow() || !nativeAccessClaimed) throw new Error("Native renderer access is unavailable")
  const result = dispatchNative(
    (api) => api?.openWorktreeInFileManager?.(accessToken, rootDirectory, registeredDirectory, targetDirectory),
    "open_worktree_in_file_manager",
    { rootDirectory, registeredDirectory, targetDirectory },
  )
  if (!result) throw new Error("Native file manager is unavailable")
  await result
}
function acknowledge(command: string, args: Record<string, unknown> = {}): Promise<void> {
  if (!isTauriHost() || !nativeAccessClaimed) return Promise.resolve()
  return invoke(command, { accessToken, ...args })
}
export const acknowledgeNativeClientStateNavigationFlush = (generation: number) =>
  acknowledge("client_state_navigation_flushed", { generation })
export const acknowledgeNativeClientStateRendererFlush = (generation: number) =>
  acknowledge("client_state_renderer_flushed", { generation })
