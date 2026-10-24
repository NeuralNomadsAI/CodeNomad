import { invoke } from "@tauri-apps/api/core"
import { isDesktopHost, isElectronHost, isNativeApplicationWindow, isTauriHost } from "../runtime-env"

// Host-owned management of the desktop data profiles: the listing (the open profile,
// the others and the one the next launch opens), deletion of the others, the choice
// of the next launch's profile and the restart into it. The renderer only sends IDs
// from a listing or a profile name; the host re-enumerates, re-validates and rechecks
// activity before deleting anything.
export type OtherDataProfileKind = "scope" | "default" | "orphan"
export type OtherDataProfileStatus = "available" | "in-use" | "unknown"
export type DataProfileDeletionOutcome = "deleted" | "incomplete" | "in-use" | "unknown" | "missing"
export type NextLaunchOutcome = "updated" | "invalid" | "busy" | "failed"

/** Milliseconds since the epoch, or null when the host cannot tell. */
type Timestamp = number | null

export interface OtherDataProfile {
  id: string
  kind: OtherDataProfileKind
  /** The profile name; "default" for the default profile. */
  name: string
  otherConfiguration: boolean
  sizeBytes: number
  sizeComplete: boolean
  status: OtherDataProfileStatus
  /** When the profile's folder was created. */
  createdAt: Timestamp
  /** When its saved desktop state was last written. */
  lastUsedAt: Timestamp
}

export interface CurrentDataProfile {
  /** The open profile's name; "default" for the default profile. */
  name: string
  sizeBytes: number
  sizeComplete: boolean
  createdAt: Timestamp
  lastUsedAt: Timestamp
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

const isSize = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const timestamp = (value: unknown): Timestamp | undefined =>
  value === null ? null : isSize(value) ? value : undefined

function normalizeProfile(value: unknown): OtherDataProfile | null {
  if (!isRecord(value)) return null
  const { id, kind, name, otherConfiguration, sizeBytes, sizeComplete, status } = value
  if (typeof id !== "string" || typeof name !== "string" || !kinds.has(kind as string) || !statuses.has(status as string)) return null
  if (typeof otherConfiguration !== "boolean" || typeof sizeComplete !== "boolean" || !isSize(sizeBytes)) return null
  const createdAt = timestamp(value.createdAt)
  const lastUsedAt = timestamp(value.lastUsedAt)
  if (createdAt === undefined || lastUsedAt === undefined) return null
  return { id, kind: kind as OtherDataProfileKind, name, otherConfiguration, sizeBytes, sizeComplete, status: status as OtherDataProfileStatus, createdAt, lastUsedAt }
}

function normalizeCurrent(value: unknown): CurrentDataProfile | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.sizeComplete !== "boolean" || !isSize(value.sizeBytes)) return null
  const createdAt = timestamp(value.createdAt)
  const lastUsedAt = timestamp(value.lastUsedAt)
  if (createdAt === undefined || lastUsedAt === undefined) return null
  return { name: value.name, sizeBytes: value.sizeBytes, sizeComplete: value.sizeComplete, createdAt, lastUsedAt }
}

export interface OtherDataProfilesListing {
  /** The open profile. */
  current: CurrentDataProfile
  /** Every other profile on this machine. */
  profiles: OtherDataProfile[]
  /** The remembered profile the next launch of this configuration opens, or null when it decides again. */
  nextLaunch: string | null
  /** `CODENOMAD_PROFILE`, its alias or a development run decides every launch: a choice cannot apply. */
  pinned: boolean
  /** macOS: Tauri's WebKit web storage is shared by profiles and is never deleted. */
  sharedWebKitStorage: boolean
}

export function normalizeOtherDataProfiles(value: unknown): OtherDataProfilesListing | null {
  if (!isRecord(value) || !Array.isArray(value.profiles) || typeof value.sharedWebKitStorage !== "boolean") return null
  if (typeof value.pinned !== "boolean" || (value.nextLaunch !== null && typeof value.nextLaunch !== "string")) return null
  const current = normalizeCurrent(value.current)
  const profiles = value.profiles.map(normalizeProfile)
  if (!current || !profiles.every(Boolean)) return null
  return {
    current,
    profiles: profiles as OtherDataProfile[],
    nextLaunch: value.nextLaunch as string | null,
    pinned: value.pinned,
    sharedWebKitStorage: value.sharedWebKitStorage,
  }
}

/**
 * The `CODENOMAD_PROFILE` grammar both hosts enforce: after trimming ASCII whitespace and
 * lowercasing ASCII letters, 1–64 characters from a-z, 0-9, ".", "_" and "-", starting with
 * a letter or digit. Returns the normalized name, or null.
 */
export function normalizeDataProfileName(value: string): string | null {
  const name = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : null
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

const nextLaunchOutcomes = new Set(["updated", "invalid", "busy", "failed"])

/**
 * Remembers which profile the next launch opens for this configuration; "default" names the
 * default profile. A name without folders yet gets its profile folder, so the launch keeps it.
 */
export async function setNextLaunchDataProfile(name: string): Promise<NextLaunchOutcome> {
  let value: unknown
  if (isElectronHost()) {
    const set = window.electronAPI?.setNextLaunchDataProfile
    if (!set) throw new Error("Data profiles are unavailable")
    value = await set(name)
  } else if (isTauriHost()) {
    value = await invoke<unknown>("data_profiles_set_next_launch", { name })
  } else {
    throw new Error("Data profiles are unavailable")
  }
  const outcome = isRecord(value) ? value.outcome : undefined
  if (!nextLaunchOutcomes.has(outcome as string)) throw new Error("Invalid next-launch result")
  return outcome as NextLaunchOutcome
}

/** Restarts the application the way it restarts after an update, into the next launch's profile. */
export async function relaunchIntoNextDataProfile(): Promise<void> {
  if (isElectronHost()) {
    const relaunch = window.electronAPI?.relaunchIntoNextDataProfile
    if (!relaunch) throw new Error("Data profiles are unavailable")
    await relaunch()
  } else if (isTauriHost()) {
    await invoke("data_profiles_relaunch")
  } else {
    throw new Error("Data profiles are unavailable")
  }
}
