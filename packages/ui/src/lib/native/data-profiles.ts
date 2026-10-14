import { invoke } from "@tauri-apps/api/core"
import { isDesktopHost, isElectronHost, isNativeApplicationWindow, isTauriHost } from "../runtime-env"

// Host-owned listing and deletion of the desktop data profiles other than the
// open one. The renderer only sends IDs from a listing; the host re-enumerates,
// re-validates and rechecks activity before deleting anything.
export type OtherDataProfileKind = "scope" | "default" | "orphan"
export type OtherDataProfileStatus = "available" | "in-use" | "unknown"
export type DataProfileDeletionOutcome = "deleted" | "incomplete" | "in-use" | "unknown" | "missing"

export interface OtherDataProfile {
  id: string
  kind: OtherDataProfileKind
  name: string
  otherConfiguration: boolean
  sizeBytes: number
  sizeComplete: boolean
  status: OtherDataProfileStatus
}

export interface DataProfileDeletion {
  id: string
  name: string
  outcome: DataProfileDeletionOutcome
  remaining: string[]
  kept: string[]
}

export interface DeleteOtherDataProfilesResult {
  results: DataProfileDeletion[]
  choices: "updated" | "unchanged" | "busy" | "failed"
}

const kinds = new Set(["scope", "default", "orphan"])
const statuses = new Set(["available", "in-use", "unknown"])
const outcomes = new Set(["deleted", "incomplete", "in-use", "unknown", "missing"])
const choiceOutcomes = new Set(["updated", "unchanged", "busy", "failed"])

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object"
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : null

function normalizeProfile(value: unknown): OtherDataProfile | null {
  if (!isRecord(value)) return null
  const { id, kind, name, otherConfiguration, sizeBytes, sizeComplete, status } = value
  if (typeof id !== "string" || typeof name !== "string" || !kinds.has(kind as string) || !statuses.has(status as string)) return null
  if (typeof otherConfiguration !== "boolean" || typeof sizeComplete !== "boolean") return null
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) return null
  return { id, kind: kind as OtherDataProfileKind, name, otherConfiguration, sizeBytes, sizeComplete, status: status as OtherDataProfileStatus }
}

export interface OtherDataProfilesListing {
  profiles: OtherDataProfile[]
  /** macOS: Tauri's WebKit web storage is shared by profiles and is never deleted. */
  sharedWebKitStorage: boolean
}

export function normalizeOtherDataProfiles(value: unknown): OtherDataProfilesListing | null {
  if (!isRecord(value) || !Array.isArray(value.profiles) || typeof value.sharedWebKitStorage !== "boolean") return null
  const profiles = value.profiles.map(normalizeProfile)
  return profiles.every(Boolean) ? { profiles: profiles as OtherDataProfile[], sharedWebKitStorage: value.sharedWebKitStorage } : null
}

export function normalizeDeleteOtherDataProfilesResult(value: unknown): DeleteOtherDataProfilesResult | null {
  if (!isRecord(value) || !Array.isArray(value.results) || !choiceOutcomes.has(value.choices as string)) return null
  const results: DataProfileDeletion[] = []
  for (const entry of value.results) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string" || !outcomes.has(entry.outcome as string)) return null
    const remaining = strings(entry.remaining)
    const kept = strings(entry.kept)
    if (!remaining || !kept) return null
    results.push({ id: entry.id, name: entry.name, outcome: entry.outcome as DataProfileDeletionOutcome, remaining, kept })
  }
  return { results, choices: value.choices as DeleteOtherDataProfilesResult["choices"] }
}

/** Local application windows and Preferences only; plain browsers and remote windows never manage profiles. */
export function canManageOtherDataProfiles(): boolean {
  if (!isDesktopHost() || !isNativeApplicationWindow()) return false
  if (isElectronHost()) return typeof window.electronAPI?.listOtherDataProfiles === "function"
  return isTauriHost()
}

export async function listOtherDataProfiles(): Promise<OtherDataProfilesListing> {
  let value: unknown
  if (isElectronHost()) {
    const list = window.electronAPI?.listOtherDataProfiles
    if (!list) throw new Error("Data profiles are unavailable")
    value = await list()
  } else if (isTauriHost()) {
    value = await invoke<unknown>("data_profiles_list_others")
  } else {
    throw new Error("Data profiles are unavailable")
  }
  const listing = normalizeOtherDataProfiles(value)
  if (!listing) throw new Error("Invalid data profile listing")
  return listing
}

export async function deleteOtherDataProfiles(ids: string[]): Promise<DeleteOtherDataProfilesResult> {
  let value: unknown
  if (isElectronHost()) {
    const remove = window.electronAPI?.deleteOtherDataProfiles
    if (!remove) throw new Error("Data profiles are unavailable")
    value = await remove(ids)
  } else if (isTauriHost()) {
    value = await invoke<unknown>("data_profiles_delete_others", { ids })
  } else {
    throw new Error("Data profiles are unavailable")
  }
  const result = normalizeDeleteOtherDataProfilesResult(value)
  if (!result) throw new Error("Invalid data profile deletion result")
  return result
}
