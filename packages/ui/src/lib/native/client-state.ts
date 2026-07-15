import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isLocalWindow, isTauriHost } from "../runtime-env"

const LEGACY_WEB_SNAPSHOT_STORAGE_KEY = "codenomad-client-snapshot-v1"
const LEGACY_WEB_RESTORE_ENABLED_STORAGE_KEY = "codenomad-client-restore-enabled-v1"
const accessToken = createAccessToken()

let nativeAccessClaimed = false

export interface NativeClientStateLoadResult {
  isPrimary: boolean
  restoreEnabled: boolean
  snapshot: unknown | null
}

function getWebStorage(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function createAccessToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function initializeWebClientState(): NativeClientStateLoadResult {
  const storage = getWebStorage()
  try {
    storage?.removeItem(LEGACY_WEB_SNAPSHOT_STORAGE_KEY)
    storage?.removeItem(LEGACY_WEB_RESTORE_ENABLED_STORAGE_KEY)
  } catch {
    // Web client snapshots are retired; inaccessible storage is already non-persistent.
  }
  return { isPrimary: false, restoreEnabled: true, snapshot: null }
}

function electronApi(): ElectronAPI | undefined {
  if (typeof window === "undefined") return undefined
  return (window as Window & { electronAPI?: ElectronAPI }).electronAPI
}

async function claimNativeClientStateAccess(): Promise<boolean> {
  if (nativeAccessClaimed) return true
  if (!isLocalWindow()) return false

  try {
    if (isElectronHost()) {
      const claim = electronApi()?.claimClientStateAccess
      nativeAccessClaimed = typeof claim === "function" && await claim(accessToken)
      return nativeAccessClaimed
    }

    if (isTauriHost()) {
      await invoke<void>("client_state_claim_access", { accessToken })
      nativeAccessClaimed = true
      return true
    }
  } catch {
    nativeAccessClaimed = false
  }
  return false
}

export async function loadNativeClientState(): Promise<NativeClientStateLoadResult> {
  if (isElectronHost()) {
    const load = electronApi()?.loadClientState
    if (typeof load !== "function" || !await claimNativeClientStateAccess()) {
      return { isPrimary: false, restoreEnabled: true, snapshot: null }
    }
    return load(accessToken)
  }

  if (isTauriHost()) {
    if (!await claimNativeClientStateAccess()) {
      return { isPrimary: false, restoreEnabled: true, snapshot: null }
    }
    return invoke<NativeClientStateLoadResult>("client_state_load", { accessToken })
  }

  return initializeWebClientState()
}

export async function saveNativeClientState(snapshot: unknown): Promise<boolean> {
  if (isElectronHost()) {
    const save = electronApi()?.saveClientState
    return nativeAccessClaimed && typeof save === "function" ? save(accessToken, snapshot) : false
  }

  if (isTauriHost()) {
    return nativeAccessClaimed ? invoke<boolean>("client_state_save", { accessToken, snapshot }) : false
  }

  return false
}

export async function setNativeRestoreEnabled(enabled: boolean): Promise<boolean> {
  if (isElectronHost()) {
    const setEnabled = electronApi()?.setClientStateRestoreEnabled
    return nativeAccessClaimed && typeof setEnabled === "function" ? setEnabled(accessToken, enabled) : false
  }

  if (isTauriHost()) {
    return nativeAccessClaimed
      ? invoke<boolean>("client_state_set_restore_enabled", { accessToken, enabled })
      : false
  }

  return false
}

export async function clearNativeClientState(): Promise<boolean> {
  if (isElectronHost()) {
    const clear = electronApi()?.clearClientState
    return nativeAccessClaimed && typeof clear === "function" ? clear(accessToken) : false
  }

  if (isTauriHost()) {
    return nativeAccessClaimed ? invoke<boolean>("client_state_clear", { accessToken }) : false
  }

  return false
}

export async function acknowledgeNativeClientStateRendererFlush(): Promise<void> {
  if (!isTauriHost() || !nativeAccessClaimed) return
  await invoke("client_state_renderer_flushed", { accessToken })
}

export async function acknowledgeNativeClientStateNavigationFlush(generation: number): Promise<void> {
  if (!isTauriHost() || !nativeAccessClaimed) return
  await invoke("client_state_navigation_flushed", { accessToken, generation })
}
