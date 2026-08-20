import type { ScrollSnapshot } from "./message-v2/types"
import { normalizeRestorableAttachmentRecord, type RestorableAttachment } from "./client-state-attachments-codec"
import type { PersistedGenerationRecovery } from "./session-generation-recovery"

export interface RestorableWorkspaceTabState {
  kind: "workspace"; folder: string; occurrence?: number; projectName?: string; binaryPath?: string
  activeParentSessionId?: string; activeSessionId?: string
  drafts: Record<string, string>; attachments: Record<string, RestorableAttachment[]>
  scrollSnapshots: Record<string, ScrollSnapshot>; unseenIdleSince: Record<string, number>
  generationRecovery: Record<string, PersistedGenerationRecovery>
  expandedSessionIds?: string[]
}

export interface RestorableSidecarTabState { kind: "sidecar"; sidecarId: string }
export type RestorableTabState = RestorableWorkspaceTabState | RestorableSidecarTabState
export interface RestorableSessionState { tabs: RestorableTabState[]; activeTabIndex: number; homeActive?: boolean }
export interface ClientSnapshotV1 {
  version: 1; revision: number; savedAt: number
  layout: Record<string, string>; session: RestorableSessionState | null
}

const MAX_TABS = 32, MAX_LAYOUT_ENTRIES = 64, MAX_DRAFTS = 24, MAX_SCROLLS_PER_TAB = 96
const MAX_IDLE_MARKERS = 256, MAX_RECOVERY = 256, MAX_EXPANDED = 256, MAX_KEY = 256, MAX_PATH = 4096, MAX_ID = 512
const MAX_LAYOUT_VALUE = 4096, MAX_DRAFT = 32 * 1024, MAX_ANCHOR_KEY = 1024
const MAX_STRINGS = 96 * 1024, MAX_SCROLLS = 256
const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"

interface StringBudget { remaining: number; scrollSnapshotsRemaining: number }

function createBudget(): StringBudget {
  return { remaining: MAX_STRINGS, scrollSnapshotsRemaining: MAX_SCROLLS }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const safeKey = (key: string) => key !== "__proto__" && key !== "constructor" && key !== "prototype"

function takeString(value: unknown, max: number, budget: StringBudget, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || value.length > max || value.length > budget.remaining) return
  if (!allowEmpty && value.trim().length === 0) return
  budget.remaining -= value.length
  return value
}

const takeNumber = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined

function normalizeRecord<T>(
  value: unknown, max: number, budget: StringBudget,
  normalize: (value: unknown) => T | undefined,
  accept: (value: unknown) => boolean = () => true,
  accepted: () => void = () => {},
  priorityKeys: readonly string[] = [],
): Record<string, T> | null {
  if (!isRecord(value)) return null
  const result: Record<string, T> = Object.create(null)
  let count = 0
  const priorities = [...new Set(priorityKeys)]
  const prioritySet = new Set(priorities)
  const entries = [
    ...priorities.flatMap((key) => Object.prototype.hasOwnProperty.call(value, key) ? [[key, value[key]] as const] : []),
    ...Object.entries(value).filter(([key]) => !prioritySet.has(key)),
  ]
  for (const [rawKey, rawValue] of entries) {
    if (count >= max) break
    if (!safeKey(rawKey) || !accept(rawValue)) continue
    const key = takeString(rawKey, MAX_KEY, budget)
    const entry = normalize(rawValue)
    if (key === undefined || entry === undefined) continue
    result[key] = entry
    count += 1
    accepted()
  }
  return result
}

function normalizeStringRecord(
  value: unknown,
  max: number,
  valueMax: number,
  budget: StringBudget,
  priorityKeys: readonly string[] = [],
) {
  return normalizeRecord(value, max, budget, (entry) => takeString(entry, valueMax, budget, true),
    undefined, undefined, priorityKeys)
}

function normalizeScrollSnapshot(value: unknown, budget: StringBudget): ScrollSnapshot | undefined {
  if (!isRecord(value)) return
  const scrollTop = takeNumber(value.scrollTop, 0, 1_000_000_000)
  const updatedAt = takeNumber(value.updatedAt, 0, Number.MAX_SAFE_INTEGER)
  if (scrollTop === undefined || updatedAt === undefined || typeof value.atBottom !== "boolean") return
  const result: ScrollSnapshot = { scrollTop, atBottom: value.atBottom, updatedAt }
  const scrollRatio = takeNumber(value.scrollRatio, 0, 1)
  const maxScrollTop = takeNumber(value.maxScrollTop, 0, 1_000_000_000)
  const anchorOffset = takeNumber(value.anchorOffset, -1_000_000, 1_000_000)
  const anchorKey = value.anchorKey === undefined ? undefined : takeString(value.anchorKey, MAX_ANCHOR_KEY, budget)
  if (scrollRatio !== undefined) result.scrollRatio = scrollRatio
  if (maxScrollTop !== undefined) result.maxScrollTop = maxScrollTop
  if (anchorKey !== undefined) result.anchorKey = anchorKey
  if (anchorOffset !== undefined) result.anchorOffset = anchorOffset
  if (value.followModeType === "following" || value.followModeType === "escaped") result.followModeType = value.followModeType
  return result
}

function normalizeExpandedSessionIds(value: unknown, budget: StringBudget): string[] | null {
  if (!Array.isArray(value)) return null
  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_EXPANDED)) {
    if (typeof entry !== "string" || seen.has(entry)) continue
    const id = takeString(entry, MAX_ID, budget)
    if (id === undefined) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

function normalizeWorkspaceTab(
  value: Record<string, unknown>,
  identity: WorkspaceIdentity,
  budget: StringBudget,
  _prioritizeDrafts: boolean,
): RestorableWorkspaceTabState | null {
  const reservedDrafts = identity.priorityDrafts
  const remainingDrafts = Object.fromEntries(Object.entries(value.drafts ?? {})
    .filter(([id]) => !Object.prototype.hasOwnProperty.call(reservedDrafts, id)))
  const additionalDrafts = normalizeStringRecord(
    remainingDrafts,
    Math.max(0, MAX_DRAFTS - Object.keys(reservedDrafts).length),
    MAX_DRAFT,
    budget,
  )
  const drafts = additionalDrafts ? { ...reservedDrafts, ...additionalDrafts } : null
  const scrollLimit = Math.min(MAX_SCROLLS_PER_TAB, budget.scrollSnapshotsRemaining)
  const scrollSnapshots = normalizeRecord(value.scrollSnapshots ?? {}, scrollLimit, budget,
    (entry) => normalizeScrollSnapshot(entry, budget), undefined,
    () => { budget.scrollSnapshotsRemaining -= 1 })
  const unseenIdleSince = normalizeRecord(value.unseenIdleSince ?? {}, MAX_IDLE_MARKERS, budget,
    (entry) => takeNumber(entry, 0, Number.MAX_SAFE_INTEGER))
  const generationRecovery = normalizeRecord<PersistedGenerationRecovery>(
    value.generationRecovery ?? {}, MAX_RECOVERY, budget,
    (entry) => entry as PersistedGenerationRecovery,
    (entry) => entry === "working" || entry === "interrupted")
  const expandedSessionIds = value.expandedSessionIds === undefined
    ? undefined
    : normalizeExpandedSessionIds(value.expandedSessionIds, budget)
  if (!drafts || !scrollSnapshots || !unseenIdleSince || !generationRecovery || expandedSessionIds === null) return null
  const remainingAttachments = Object.fromEntries(Object.entries(value.attachments ?? {})
    .filter(([id]) => !identity.prioritySessionIds.includes(id)))
  const attachmentResult = normalizeRestorableAttachmentRecord(
    remainingAttachments, drafts,
  )
  if (!attachmentResult) return null

  const result: RestorableWorkspaceTabState = {
    kind: "workspace", folder: identity.folder,
    drafts: attachmentResult.drafts,
    attachments: { ...identity.priorityAttachments, ...attachmentResult.attachments },
    scrollSnapshots, unseenIdleSince, generationRecovery,
  }
  if (expandedSessionIds !== undefined) result.expandedSessionIds = expandedSessionIds
  if (Number.isInteger(value.occurrence) && Number(value.occurrence) >= 0 && Number(value.occurrence) < MAX_TABS) {
    result.occurrence = Number(value.occurrence)
  }
  const projectName = value.projectName === undefined ? undefined : takeString(value.projectName, MAX_PATH, budget)
  const binaryPath = value.binaryPath === undefined ? undefined : takeString(value.binaryPath, MAX_PATH, budget)
  if (projectName !== undefined) result.projectName = projectName
  if (binaryPath !== undefined) result.binaryPath = binaryPath
  if (identity.activeParentSessionId !== undefined) result.activeParentSessionId = identity.activeParentSessionId
  if (identity.activeSessionId !== undefined) result.activeSessionId = identity.activeSessionId
  return result
}

interface WorkspaceIdentity {
  kind: "workspace"; value: Record<string, unknown>; folder: string
  activeParentSessionId?: string; activeSessionId?: string
  prioritySessionIds: string[]; priorityDrafts: Record<string, string>
  priorityAttachments: Record<string, RestorableAttachment[]>
}
type TabIdentity = WorkspaceIdentity | RestorableSidecarTabState

function normalizeIdentity(value: unknown, budget: StringBudget): TabIdentity | null {
  if (!isRecord(value)) return null
  const kind = value.kind ?? value.type
  if (kind === "sidecar") {
    const sidecarId = takeString(value.sidecarId, MAX_ID, budget)
    return sidecarId === undefined ? null : { kind, sidecarId }
  }
  if (kind !== "workspace" && kind !== "instance") return null
  if (!["drafts", "attachments", "scrollSnapshots", "unseenIdleSince", "generationRecovery"]
    .every((key) => isRecord(value[key] ?? {}))) return null
  const folder = takeString(value.folder, MAX_PATH, budget)
  if (folder === undefined) return null
  const activeParentSessionId = value.activeParentSessionId === undefined ? undefined
    : takeString(value.activeParentSessionId, MAX_ID, budget)
  const activeSessionId = value.activeSessionId === undefined ? undefined : takeString(value.activeSessionId, MAX_ID, budget)
  const prioritySessionIds = [activeSessionId, NO_SESSION_DRAFT_SESSION_ID]
    .filter((id): id is string => Boolean(id))
  return {
    kind: "workspace", value, folder, activeParentSessionId, activeSessionId,
    prioritySessionIds, priorityDrafts: Object.create(null), priorityAttachments: Object.create(null),
  }
}

function reservePriorityDrafts(identity: WorkspaceIdentity, budget: StringBudget): void {
  const drafts = identity.value.drafts ?? {}
  if (!isRecord(drafts)) return
  for (const rawKey of identity.prioritySessionIds) {
    if (!safeKey(rawKey) || !Object.prototype.hasOwnProperty.call(drafts, rawKey)) continue
    const remaining = budget.remaining
    const key = takeString(rawKey, MAX_KEY, budget)
    const draft = takeString(drafts[rawKey], MAX_DRAFT, budget, true)
    if (key === undefined || draft === undefined) {
      budget.remaining = remaining
      continue
    }
    identity.priorityDrafts[key] = draft
  }
  const attachments = identity.value.attachments ?? {}
  if (!isRecord(attachments)) return
  const priorityAttachments = Object.fromEntries(identity.prioritySessionIds
    .filter((id) => Object.prototype.hasOwnProperty.call(attachments, id))
    .map((id) => [id, attachments[id]]))
  const result = normalizeRestorableAttachmentRecord(
    priorityAttachments,
    identity.priorityDrafts,
    identity.prioritySessionIds,
  )
  if (!result) return
  identity.priorityDrafts = result.drafts
  identity.priorityAttachments = result.attachments
}

export function normalizeRestorableSession(value: unknown): RestorableSessionState | null {
  return normalizeSession(value, createBudget())
}

function normalizeSession(value: unknown, budget: StringBudget): RestorableSessionState | null {
  if (!isRecord(value) || !Array.isArray(value.tabs) || !Number.isInteger(value.activeTabIndex)) return null
  const requested = Number(value.activeTabIndex)
  const rawTabs = value.tabs.slice(0, MAX_TABS)
  const identityByIndex = new Map<number, TabIdentity>()
  const normalizedByIndex = new Map<number, RestorableTabState>()
  const normalizeIdentityAt = (originalIndex: number) => {
    const identity = normalizeIdentity(rawTabs[originalIndex], budget)
    if (!identity) return
    identityByIndex.set(originalIndex, identity)
  }
  const normalizeTabAt = (originalIndex: number, prioritizeDrafts: boolean) => {
    const identity = identityByIndex.get(originalIndex)
    if (!identity) return
    const tab = identity.kind === "sidecar"
      ? identity
      : normalizeWorkspaceTab(identity.value, identity, budget, prioritizeDrafts)
    if (tab) normalizedByIndex.set(originalIndex, tab)
  }
  rawTabs.forEach((_tab, index) => normalizeIdentityAt(index))
  const priorityOrder = [requested, ...rawTabs.map((_tab, index) => index).filter((index) => index !== requested)]
  for (const index of priorityOrder) {
    const identity = identityByIndex.get(index)
    if (identity?.kind === "workspace") reservePriorityDrafts(identity, budget)
  }
  if (rawTabs[requested] !== undefined) normalizeTabAt(requested, true)
  rawTabs.forEach((_tab, index) => {
    if (index !== requested) normalizeTabAt(index, true)
  })
  const identities = rawTabs.flatMap((_tab, originalIndex) => {
    const identity = identityByIndex.get(originalIndex)
    return identity ? [{ originalIndex, identity }] : []
  })
  const normalized = identities.flatMap(({ originalIndex }) => {
    const tab = normalizedByIndex.get(originalIndex)
    return tab ? [{ originalIndex, tab }] : []
  })
  if (value.tabs.length && !normalized.length) return null

  const tabs = normalized.map(({ tab }) => tab)
  const surviving = normalized.findIndex(({ originalIndex }) => originalIndex === requested)
  const next = normalized.findIndex(({ originalIndex }) => originalIndex > requested)
  const activeTabIndex = !tabs.length ? -1 : surviving >= 0 ? surviving : next >= 0 ? next : tabs.length - 1
  return { tabs, activeTabIndex, ...(value.homeActive === true ? { homeActive: true } : {}) }
}

export function decodeClientSnapshot(value: unknown): ClientSnapshotV1 | null {
  if (!isRecord(value) || (value.version !== undefined && value.version !== 1)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return null
  const savedAt = takeNumber(value.savedAt, 0, Number.MAX_SAFE_INTEGER)
  if (savedAt === undefined) return null
  const budget = createBudget()
  const session = value.session === null ? null : normalizeSession(value.session, budget)
  if (value.session !== null && !session) return null
  const layout = normalizeStringRecord(value.layout, MAX_LAYOUT_ENTRIES, MAX_LAYOUT_VALUE, budget)
  return layout ? { version: 1, revision: Number(value.revision), savedAt, layout, session } : null
}

export function isFutureClientSnapshot(value: unknown): boolean {
  return isRecord(value) && typeof value.version === "number" && Number.isInteger(value.version) && value.version > 2
}
