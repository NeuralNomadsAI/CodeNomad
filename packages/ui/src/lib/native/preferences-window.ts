import type { LocationRef } from "@opencode/client"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isTauriHost, runtimeEnv } from "../runtime-env"
import type { SettingsSectionId } from "../../stores/settings-screen"
import { getLogger } from "../logger"

const sections = new Set<SettingsSectionId>([
  "general", "chat", "notifications", "speech", "remote", "opencode",
  "providers", "usage", "sidecars", "config-files", "advanced", "info",
])

export interface NativePreferencesRequest {
  section: SettingsSectionId
  scrollTop?: number
  instanceId?: string
  location?: LocationRef
}

export function normalizeNativePreferencesRequest(value: unknown): NativePreferencesRequest | null {
  if (typeof value === "string") return sections.has(value as SettingsSectionId) ? { section: value as SettingsSectionId } : null
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  if (!sections.has(candidate.section as SettingsSectionId)) return null
  const location = candidate.location
  return {
    section: candidate.section as SettingsSectionId,
    ...(Number.isSafeInteger(candidate.scrollTop) && (candidate.scrollTop as number) >= 0 && (candidate.scrollTop as number) <= 10_000_000 ? { scrollTop: candidate.scrollTop as number } : {}),
    ...(typeof candidate.instanceId === "string" && candidate.instanceId ? { instanceId: candidate.instanceId } : {}),
    ...(location && typeof location === "object" && typeof (location as LocationRef).directory === "string"
      ? { location: location as LocationRef }
      : {}),
  }
}

export function readPreferencesRequestFromUrl(url: string): NativePreferencesRequest | null {
  const params = new URL(url).searchParams
  const section = params.get("preferences")
  if (!section || !sections.has(section as SettingsSectionId)) return null
  const instanceId = params.get("preferencesInstanceId") || undefined
  const directory = params.get("preferencesDirectory")
  const workspaceID = params.get("preferencesWorkspaceId") || undefined
  return {
    section: section as SettingsSectionId,
    ...(instanceId ? { instanceId } : {}),
    ...(directory !== null ? { location: { directory, ...(workspaceID ? { workspaceID } : {}) } } : {}),
  }
}

export async function openNativePreferences(request: NativePreferencesRequest, toggle = false, resume = false): Promise<void> {
  if (runtimeEnv.host === "electron") {
    const open = window.electronAPI?.openPreferences
    if (!open) throw new Error("Native Preferences is unavailable")
    await open(request.section, { instanceId: request.instanceId, location: request.location }, toggle, resume)
    return
  }
  if (runtimeEnv.host === "tauri") {
    await invoke("open_preferences_window", { request, toggle, resume })
    return
  }
  throw new Error("Native Preferences is unavailable")
}

export async function markNativePreferencesReady(): Promise<void> {
  if (isElectronHost()) {
    await window.electronAPI?.preferencesReady?.()
  } else if (isTauriHost()) {
    await invoke("preferences_window_ready")
  }
}

export async function acceptNativePreferencesRequest(request: NativePreferencesRequest, generation?: number): Promise<void> {
  if (isElectronHost()) {
    await window.electronAPI?.acceptPreferencesRequest?.(request)
  } else if (isTauriHost()) {
    await invoke("preferences_accept_request", { request, generation })
  }
}

export async function onNativePreferencesFlushRequested(flush: (generation?: number) => Promise<void>): Promise<() => void> {
  if (isElectronHost()) {
    window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ = flush
    return () => {
      if (window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ === flush) {
        delete window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__
      }
    }
  }
  if (isTauriHost()) {
    return listen<{ generation: number }>("client-state:flush-requested", event => {
      void flush(event.payload.generation).catch(error => getLogger("actions").warn("Preferences shutdown flush failed", error))
    })
  }
  return () => undefined
}

export async function getNativePreferencesRequest(): Promise<NativePreferencesRequest> {
  const fromUrl = readPreferencesRequestFromUrl(window.location.href)
  if (isElectronHost()) {
    const api = window.electronAPI
    const value = api?.getPreferencesRequest
      ? await api.getPreferencesRequest()
      : await api?.getPreferencesSection?.()
    return normalizeNativePreferencesRequest(value) ?? fromUrl ?? { section: "general" }
  }
  if (isTauriHost()) {
    const value = await invoke<unknown>("preferences_get_request")
    return normalizeNativePreferencesRequest(value) ?? fromUrl ?? { section: "general" }
  }
  return fromUrl ?? { section: "general" }
}

export async function onNativePreferencesRequest(callback: (request: NativePreferencesRequest) => void): Promise<() => void> {
  if (isElectronHost()) {
    return window.electronAPI?.onPreferencesSection?.((value) => {
      const request = normalizeNativePreferencesRequest(value)
      if (request) callback(request)
    }) ?? (() => undefined)
  }
  if (isTauriHost()) {
    return await listen<unknown>("preferences:section", (event) => {
      const request = normalizeNativePreferencesRequest(event.payload)
      if (request) callback(request)
    })
  }
  return () => undefined
}

export async function onNativePreferencesCloseRequested(callback: () => void): Promise<() => void> {
  if (isElectronHost()) return window.electronAPI?.onPreferencesCloseRequested?.(callback) ?? (() => undefined)
  if (isTauriHost()) return await listen("preferences:close-requested", callback)
  return () => undefined
}

export async function onNativePreferencesTransitionRequested(callback: (id: number) => void): Promise<() => void> {
  const handle = (value: unknown) => {
    if (value && typeof value === "object" && Number.isSafeInteger((value as { id?: unknown }).id)) {
      callback((value as { id: number }).id)
    }
  }
  if (isElectronHost()) return window.electronAPI?.onPreferencesTransitionRequested?.(handle) ?? (() => undefined)
  if (isTauriHost()) return await listen<unknown>("preferences:transition-requested", (event) => handle(event.payload))
  return () => undefined
}

export async function resolveNativePreferencesTransition(id: number, approved: boolean): Promise<void> {
  if (isElectronHost()) {
    await window.electronAPI?.resolvePreferencesTransition?.(id, approved)
  } else if (isTauriHost()) {
    await invoke("preferences_resolve_transition", { id, approved })
  }
}
