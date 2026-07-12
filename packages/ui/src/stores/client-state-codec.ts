import type { ScrollSnapshot } from "./message-v2/types"
import {
  createAttachmentCodecBudget,
  normalizeRestorableAttachmentRecord,
  type AttachmentCodecBudget,
  type RestorableAttachment,
} from "./client-state-attachments-codec"
import type { PersistedGenerationRecovery } from "./session-generation-recovery"

export interface RestorableWorkspaceTabState {
  kind: "workspace"
  folder: string
  occurrence?: number
  projectName?: string
  binaryPath?: string
  activeParentSessionId?: string
  activeSessionId?: string
  drafts: Record<string, string>
  attachments: Record<string, RestorableAttachment[]>
  scrollSnapshots: Record<string, ScrollSnapshot>
  unseenIdleSince: Record<string, number>
  generationRecovery: Record<string, PersistedGenerationRecovery>
}

export interface RestorableSidecarTabState {
  kind: "sidecar"
  sidecarId: string
}

export type RestorableTabState = RestorableWorkspaceTabState | RestorableSidecarTabState

export interface RestorableSessionState {
  tabs: RestorableTabState[]
  activeTabIndex: number
}

export interface ClientSnapshotV1 {
  version: 1
  revision: number
  savedAt: number
  layout: Record<string, string>
  session: RestorableSessionState | null
}

const MAX_TABS = 32
const MAX_LAYOUT_ENTRIES = 64
const MAX_DRAFTS_PER_TAB = 24
const MAX_SCROLL_SNAPSHOTS_PER_TAB = 96
const MAX_IDLE_MARKERS_PER_TAB = 256
const MAX_GENERATION_RECOVERY_PER_TAB = 256
const MAX_KEY_LENGTH = 256
const MAX_PATH_LENGTH = 4096
const MAX_ID_LENGTH = 512
const MAX_LAYOUT_VALUE_LENGTH = 4096
const MAX_DRAFT_LENGTH = 32 * 1024
const MAX_ANCHOR_KEY_LENGTH = 1024
const MAX_TOTAL_STRING_LENGTH = 96 * 1024
const MAX_TOTAL_SCROLL_SNAPSHOTS = 256

interface StringBudget {
  remaining: number
  scrollSnapshotsRemaining: number
  attachments: AttachmentCodecBudget
}

function createStringBudget(): StringBudget {
  return {
    remaining: MAX_TOTAL_STRING_LENGTH,
    scrollSnapshotsRemaining: MAX_TOTAL_SCROLL_SNAPSHOTS,
    attachments: createAttachmentCodecBudget(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafeRecordKey(key: string): boolean {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype"
}

function takeString(
  value: unknown,
  maxLength: number,
  budget: StringBudget,
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  if (typeof value !== "string" || value.length > maxLength || value.length > budget.remaining) return undefined
  if (!options.allowEmpty && value.trim().length === 0) return undefined
  budget.remaining -= value.length
  return value
}

function takeOptionalString(value: unknown, maxLength: number, budget: StringBudget): string | undefined {
  return value === undefined ? undefined : takeString(value, maxLength, budget)
}

function takeFiniteNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return undefined
  return value
}

function normalizeStringRecord(
  value: unknown,
  maxEntries: number,
  maxValueLength: number,
  budget: StringBudget,
): Record<string, string> | null {
  if (!isRecord(value)) return null

  const result: Record<string, string> = Object.create(null)
  let count = 0
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (count >= maxEntries) break
    if (!isSafeRecordKey(rawKey)) continue

    const key = takeString(rawKey, MAX_KEY_LENGTH, budget)
    const entry = takeString(rawValue, maxValueLength, budget, { allowEmpty: true })
    if (key === undefined || entry === undefined) continue
    result[key] = entry
    count += 1
  }
  return result
}

function normalizeScrollSnapshot(value: unknown, budget: StringBudget): ScrollSnapshot | null {
  if (!isRecord(value)) return null

  const scrollTop = takeFiniteNumber(value.scrollTop, 0, 1_000_000_000)
  const updatedAt = takeFiniteNumber(value.updatedAt, 0, Number.MAX_SAFE_INTEGER)
  if (scrollTop === undefined || updatedAt === undefined || typeof value.atBottom !== "boolean") return null

  const result: ScrollSnapshot = { scrollTop, atBottom: value.atBottom, updatedAt }

  if (value.scrollRatio !== undefined) {
    const scrollRatio = takeFiniteNumber(value.scrollRatio, 0, 1)
    if (scrollRatio !== undefined) result.scrollRatio = scrollRatio
  }
  if (value.maxScrollTop !== undefined) {
    const maxScrollTop = takeFiniteNumber(value.maxScrollTop, 0, 1_000_000_000)
    if (maxScrollTop !== undefined) result.maxScrollTop = maxScrollTop
  }
  if (value.anchorKey !== undefined) {
    const anchorKey = takeString(value.anchorKey, MAX_ANCHOR_KEY_LENGTH, budget)
    if (anchorKey !== undefined) result.anchorKey = anchorKey
  }
  if (value.anchorOffset !== undefined) {
    const anchorOffset = takeFiniteNumber(value.anchorOffset, -1_000_000, 1_000_000)
    if (anchorOffset !== undefined) result.anchorOffset = anchorOffset
  }
  if (value.followModeType === "following" || value.followModeType === "escaped") {
    result.followModeType = value.followModeType
  }

  return result
}

function normalizeScrollSnapshotRecord(value: unknown, budget: StringBudget): Record<string, ScrollSnapshot> | null {
  if (!isRecord(value)) return null

  const result: Record<string, ScrollSnapshot> = Object.create(null)
  let count = 0
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (count >= MAX_SCROLL_SNAPSHOTS_PER_TAB || budget.scrollSnapshotsRemaining <= 0) break
    if (!isSafeRecordKey(rawKey)) continue

    const key = takeString(rawKey, MAX_KEY_LENGTH, budget)
    const snapshot = normalizeScrollSnapshot(rawValue, budget)
    if (key === undefined || snapshot === null) continue
    result[key] = snapshot
    count += 1
    budget.scrollSnapshotsRemaining -= 1
  }
  return result
}

function normalizeIdleMarkerRecord(value: unknown, budget: StringBudget): Record<string, number> | null {
  if (!isRecord(value)) return null

  const result: Record<string, number> = Object.create(null)
  let count = 0
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (count >= MAX_IDLE_MARKERS_PER_TAB) break
    if (!isSafeRecordKey(rawKey)) continue

    const key = takeString(rawKey, MAX_KEY_LENGTH, budget)
    const idleSince = takeFiniteNumber(rawValue, 0, Number.MAX_SAFE_INTEGER)
    if (key === undefined || idleSince === undefined) continue
    result[key] = idleSince
    count += 1
  }
  return result
}

function normalizeGenerationRecoveryRecord(
  value: unknown,
  budget: StringBudget,
): Record<string, PersistedGenerationRecovery> | null {
  if (!isRecord(value)) return null

  const result: Record<string, PersistedGenerationRecovery> = Object.create(null)
  let count = 0
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (count >= MAX_GENERATION_RECOVERY_PER_TAB) break
    if (!isSafeRecordKey(rawKey) || (rawValue !== "working" && rawValue !== "interrupted")) continue

    const key = takeString(rawKey, MAX_KEY_LENGTH, budget)
    if (key === undefined) continue
    result[key] = rawValue
    count += 1
  }
  return result
}

function normalizeWorkspaceTab(value: Record<string, unknown>, budget: StringBudget): RestorableWorkspaceTabState | null {
  const folder = takeString(value.folder, MAX_PATH_LENGTH, budget)
  if (folder === undefined) return null

  const normalizedDrafts = normalizeStringRecord(value.drafts ?? {}, MAX_DRAFTS_PER_TAB, MAX_DRAFT_LENGTH, budget)
  const scrollSnapshots = normalizeScrollSnapshotRecord(value.scrollSnapshots ?? {}, budget)
  const unseenIdleSince = normalizeIdleMarkerRecord(value.unseenIdleSince ?? {}, budget)
  const generationRecovery = normalizeGenerationRecoveryRecord(value.generationRecovery ?? {}, budget)
  if (
    normalizedDrafts === null
    || scrollSnapshots === null
    || unseenIdleSince === null
    || generationRecovery === null
  ) return null
  const attachmentResult = normalizeRestorableAttachmentRecord(value.attachments ?? {}, normalizedDrafts, budget.attachments)
  if (attachmentResult === null) return null

  const result: RestorableWorkspaceTabState = {
    kind: "workspace",
    folder,
    drafts: attachmentResult.drafts,
    attachments: attachmentResult.attachments,
    scrollSnapshots,
    unseenIdleSince,
    generationRecovery,
  }
  if (Number.isInteger(value.occurrence) && Number(value.occurrence) >= 0 && Number(value.occurrence) < MAX_TABS) {
    result.occurrence = Number(value.occurrence)
  }
  const projectName = takeOptionalString(value.projectName, MAX_PATH_LENGTH, budget)
  const binaryPath = takeOptionalString(value.binaryPath, MAX_PATH_LENGTH, budget)
  const activeParentSessionId = takeOptionalString(value.activeParentSessionId, MAX_ID_LENGTH, budget)
  const activeSessionId = takeOptionalString(value.activeSessionId, MAX_ID_LENGTH, budget)

  if (projectName !== undefined) result.projectName = projectName
  if (binaryPath !== undefined) result.binaryPath = binaryPath
  if (activeParentSessionId !== undefined) result.activeParentSessionId = activeParentSessionId
  if (activeSessionId !== undefined) result.activeSessionId = activeSessionId
  return result
}

function normalizeTab(value: unknown, budget: StringBudget): RestorableTabState | null {
  if (!isRecord(value)) return null

  // `type` is accepted as an early-schema migration alias, but v1 is always
  // written with `kind` so subsequent loads have one canonical shape.
  const kind = value.kind ?? value.type
  if (kind === "workspace" || kind === "instance") return normalizeWorkspaceTab(value, budget)
  if (kind !== "sidecar") return null

  const sidecarId = takeString(value.sidecarId, MAX_ID_LENGTH, budget)
  return sidecarId === undefined ? null : { kind: "sidecar", sidecarId }
}

export function normalizeRestorableSession(value: unknown): RestorableSessionState | null {
  return normalizeRestorableSessionWithBudget(value, createStringBudget())
}

function normalizeRestorableSessionWithBudget(value: unknown, budget: StringBudget): RestorableSessionState | null {
  if (!isRecord(value) || !Array.isArray(value.tabs) || !Number.isInteger(value.activeTabIndex)) return null

  const normalizedTabs: Array<{ originalIndex: number; tab: RestorableTabState }> = []
  for (const [originalIndex, rawTab] of value.tabs.slice(0, MAX_TABS).entries()) {
    const tab = normalizeTab(rawTab, budget)
    if (tab) normalizedTabs.push({ originalIndex, tab })
  }

  const tabs = normalizedTabs.map((entry) => entry.tab)
  if (value.tabs.length > 0 && tabs.length === 0) return null
  const requestedActiveTabIndex = Number(value.activeTabIndex)
  const survivingActiveIndex = normalizedTabs.findIndex((entry) => entry.originalIndex === requestedActiveTabIndex)
  const fallbackActiveIndex = normalizedTabs.findIndex((entry) => entry.originalIndex > requestedActiveTabIndex)
  const activeTabIndex = tabs.length === 0
    ? -1
    : survivingActiveIndex >= 0
      ? survivingActiveIndex
      : fallbackActiveIndex >= 0
        ? fallbackActiveIndex
        : tabs.length - 1
  return { tabs, activeTabIndex }
}

export function decodeClientSnapshot(value: unknown): ClientSnapshotV1 | null {
  if (!isRecord(value) || value.version !== 1) return null
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return null

  const savedAt = takeFiniteNumber(value.savedAt, 0, Number.MAX_SAFE_INTEGER)
  if (savedAt === undefined) return null

  const budget = createStringBudget()
  const layout = normalizeStringRecord(value.layout, MAX_LAYOUT_ENTRIES, MAX_LAYOUT_VALUE_LENGTH, budget)
  if (layout === null) return null

  let session: RestorableSessionState | null = null
  if (value.session !== null) {
    session = normalizeRestorableSessionWithBudget(value.session, budget)
    if (session === null) return null
  }

  return {
    version: 1,
    revision: Number(value.revision),
    savedAt,
    layout,
    session,
  }
}

export function isFutureClientSnapshot(value: unknown): boolean {
  return isRecord(value) && typeof value.version === "number" && Number.isInteger(value.version) && value.version > 1
}
