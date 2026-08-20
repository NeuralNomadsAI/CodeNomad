import { decodeClientSnapshot, normalizeRestorableSession } from "./client-state-codec"
import type { ClientSnapshotV1, RestorableSessionState, RestorableWorkspaceTabState } from "./client-state-codec"

const MAX_PARTITION_BYTES = 1024 * 1024
const MAX_ROOT_BYTES = 1024 * 1024
const MAX_NATIVE_PARTITIONS = 4096
const MAX_SESSION_ID = 512
const PARTITION_KEY = /^[0-9a-f]{64}$/
const ROOT_KEYS = ["layout", "partitionKeys", "revision", "savedAt", "sessionPartition", "version"]
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])
const encoder = new TextEncoder()

export interface ClientSnapshotV2 {
  version: 2
  revision: number
  savedAt: number
  layout: Record<string, string>
  sessionPartition: string
  partitionKeys: string[]
}

export interface EncodedClientSnapshotV2 {
  root: ClientSnapshotV2
  partitions: Record<string, string>
  partitionKeys: string[]
}

interface SessionDocument {
  format: 1
  draft?: string
  attachments?: RestorableWorkspaceTabState["attachments"][string]
  scrollSnapshot?: RestorableWorkspaceTabState["scrollSnapshots"][string]
  unseenIdleSince?: number
  generationRecovery?: RestorableWorkspaceTabState["generationRecovery"][string]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const isSafePersistedSessionId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_ID
  && value.trim().length > 0 && !UNSAFE_KEYS.has(value)

function isPartitionKeyArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((key, index) =>
    typeof key === "string" && PARTITION_KEY.test(key) && (index === 0 || value[index - 1]! < key))
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]))
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortJson(value))
  if (serialized === undefined) throw new TypeError("Client state partition must be JSON-serializable")
  return serialized
}

function canonicalEquals(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    return false
  }
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function encodeSessionGraph(session: RestorableSessionState | null) {
  const generated: Record<string, string> = Object.create(null)
  const addPartition = async (value: unknown) => {
    const partition = canonicalJson(value)
    const key = await sha256(partition)
    generated[key] = partition
    return key
  }

  const encodedSession = session === null ? null : {
    tabs: await Promise.all(session.tabs.map(async (tab) => {
      if (tab.kind === "sidecar") return { kind: tab.kind, sidecarId: tab.sidecarId }

      const sessionIds = new Set([
        ...Object.keys(tab.drafts),
        ...Object.keys(tab.attachments),
        ...Object.keys(tab.scrollSnapshots),
        ...Object.keys(tab.unseenIdleSince),
        ...Object.keys(tab.generationRecovery),
      ])
      const sessions: Record<string, string> = Object.create(null)
      for (const sessionId of [...sessionIds].sort()) {
        const document: SessionDocument = { format: 1 }
        if (hasOwn(tab.drafts, sessionId)) document.draft = tab.drafts[sessionId]
        if (hasOwn(tab.attachments, sessionId)) document.attachments = tab.attachments[sessionId]
        if (hasOwn(tab.scrollSnapshots, sessionId)) document.scrollSnapshot = tab.scrollSnapshots[sessionId]
        if (hasOwn(tab.unseenIdleSince, sessionId)) document.unseenIdleSince = tab.unseenIdleSince[sessionId]
        if (hasOwn(tab.generationRecovery, sessionId)) document.generationRecovery = tab.generationRecovery[sessionId]
        sessions[sessionId] = await addPartition(document)
      }

      const workspace: Record<string, unknown> = { format: 1, sessions }
      if (tab.activeParentSessionId !== undefined) workspace.activeParentSessionId = tab.activeParentSessionId
      if (tab.activeSessionId !== undefined) workspace.activeSessionId = tab.activeSessionId
      if (tab.expandedSessionIds !== undefined) workspace.expandedSessionIds = tab.expandedSessionIds
      const shell: Record<string, unknown> = {
        kind: tab.kind,
        folder: tab.folder,
        workspacePartition: await addPartition(workspace),
      }
      if (tab.occurrence !== undefined) shell.occurrence = tab.occurrence
      if (tab.projectName !== undefined) shell.projectName = tab.projectName
      if (tab.binaryPath !== undefined) shell.binaryPath = tab.binaryPath
      return shell
    })),
    activeTabIndex: session.activeTabIndex,
    ...(session.homeActive !== undefined ? { homeActive: session.homeActive } : {}),
  }
  const sessionPartition = await addPartition({ format: 2, session: encodedSession })
  const partitionKeys = Object.keys(generated).sort()
  return {
    sessionPartition,
    partitionKeys,
    partitions: Object.fromEntries(partitionKeys.map((key) => [key, generated[key]!])),
  }
}

export async function encodeClientSnapshotV2(snapshot: ClientSnapshotV1): Promise<EncodedClientSnapshotV2> {
  const graph = await encodeSessionGraph(snapshot.session)
  return {
    root: {
      version: 2,
      revision: snapshot.revision,
      savedAt: snapshot.savedAt,
      layout: snapshot.layout,
      sessionPartition: graph.sessionPartition,
      partitionKeys: graph.partitionKeys,
    },
    partitions: graph.partitions,
    partitionKeys: graph.partitionKeys,
  }
}

export const canCommitClientSnapshotV2 = (encoded: EncodedClientSnapshotV2): boolean =>
  encoded.partitionKeys.length <= MAX_NATIVE_PARTITIONS

function decodeRoot(value: unknown): { root: ClientSnapshotV1; partitionKey: string; partitionKeys: string[] } | null {
  if (!isRecord(value) || value.version !== 2 || typeof value.sessionPartition !== "string"
    || !PARTITION_KEY.test(value.sessionPartition)
    || !isPartitionKeyArray(value.partitionKeys)
    || !value.partitionKeys.includes(value.sessionPartition)
    || Object.keys(value).sort().join("\0") !== ROOT_KEYS.join("\0")) return null
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return null
  }
  if (encoder.encode(serialized).byteLength > MAX_ROOT_BYTES) return null
  const root = decodeClientSnapshot({ ...value, version: 1, session: null })
  if (!root || !canonicalEquals(value, {
    version: 2,
    revision: root.revision,
    savedAt: root.savedAt,
    layout: root.layout,
    sessionPartition: value.sessionPartition,
    partitionKeys: value.partitionKeys,
  })) return null
  return { root, partitionKey: value.sessionPartition, partitionKeys: value.partitionKeys }
}

function parseJson(value: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(value) as unknown }
  } catch {
    return null
  }
}

async function decodeGraph(
  manifest: Record<string, unknown>,
  rootKey: string,
  persistedKeys: readonly string[],
  loaded: Map<string, string>,
  loadPartition: (key: string) => Promise<string | null>,
): Promise<RestorableSessionState | null | undefined> {
  if (!hasExactKeys(manifest, ["format", "session"]) || canonicalJson(manifest) !== loaded.get(rootKey)) return
  if (manifest.session === null) {
    const reencoded = await encodeSessionGraph(null)
    return graphMatches(reencoded, rootKey, persistedKeys, loaded) ? null : undefined
  }
  if (!isRecord(manifest.session)
    || !hasExactKeys(manifest.session, ["tabs", "activeTabIndex"], ["homeActive"])
    || !Array.isArray(manifest.session.tabs)) return

  const loadCanonical = async (key: unknown): Promise<Record<string, unknown> | null> => {
    if (typeof key !== "string" || !PARTITION_KEY.test(key)) return null
    let partition = loaded.get(key)
    if (partition === undefined) {
      partition = await loadPartition(key) ?? undefined
      if (partition === undefined || encoder.encode(partition).byteLength > MAX_PARTITION_BYTES
        || await sha256(partition) !== key) return null
      loaded.set(key, partition)
    }
    const parsed = parseJson(partition)
    return parsed && isRecord(parsed.value) && canonicalJson(parsed.value) === partition ? parsed.value : null
  }

  const tabs: unknown[] = []
  for (const shell of manifest.session.tabs) {
    if (!isRecord(shell)) return
    if (shell.kind === "sidecar") {
      if (!hasExactKeys(shell, ["kind", "sidecarId"])) return
      tabs.push({ kind: shell.kind, sidecarId: shell.sidecarId })
      continue
    }
    if (shell.kind !== "workspace"
      || !hasExactKeys(shell, ["kind", "folder", "workspacePartition"], ["occurrence", "projectName", "binaryPath"])) return
    const workspace = await loadCanonical(shell.workspacePartition)
    if (!workspace || workspace.format !== 1
      || !hasExactKeys(workspace, ["format", "sessions"],
        ["activeParentSessionId", "activeSessionId", "expandedSessionIds"])
      || !isRecord(workspace.sessions)) return
    if (!Object.keys(workspace.sessions).every(isSafePersistedSessionId)
      || (hasOwn(workspace, "activeParentSessionId") && !isSafePersistedSessionId(workspace.activeParentSessionId))
      || (hasOwn(workspace, "activeSessionId") && !isSafePersistedSessionId(workspace.activeSessionId))
      || (hasOwn(workspace, "expandedSessionIds") && (!Array.isArray(workspace.expandedSessionIds)
        || !workspace.expandedSessionIds.every(isSafePersistedSessionId)))) return

    const tab: Record<string, unknown> = {
      kind: shell.kind,
      folder: shell.folder,
      drafts: Object.create(null),
      attachments: Object.create(null),
      scrollSnapshots: Object.create(null),
      unseenIdleSince: Object.create(null),
      generationRecovery: Object.create(null),
    }
    for (const key of ["occurrence", "projectName", "binaryPath"] as const) {
      if (hasOwn(shell, key)) tab[key] = shell[key]
    }
    for (const key of ["activeParentSessionId", "activeSessionId", "expandedSessionIds"] as const) {
      if (hasOwn(workspace, key)) tab[key] = workspace[key]
    }
    for (const [sessionId, documentKey] of Object.entries(workspace.sessions)) {
      const document = await loadCanonical(documentKey)
      if (!document || document.format !== 1
        || !hasExactKeys(document, ["format"],
          ["draft", "attachments", "scrollSnapshot", "unseenIdleSince", "generationRecovery"])
        || Object.keys(document).length === 1) return
      const fields = [
        ["draft", "drafts"],
        ["attachments", "attachments"],
        ["scrollSnapshot", "scrollSnapshots"],
        ["unseenIdleSince", "unseenIdleSince"],
        ["generationRecovery", "generationRecovery"],
      ] as const
      for (const [documentField, stateField] of fields) {
        if (hasOwn(document, documentField)) (tab[stateField] as Record<string, unknown>)[sessionId] = document[documentField]
      }
    }
    tabs.push(tab)
  }

  const reconstructed: unknown = {
    tabs,
    activeTabIndex: manifest.session.activeTabIndex,
    ...(hasOwn(manifest.session, "homeActive") ? { homeActive: manifest.session.homeActive } : {}),
  }
  const normalized = normalizeRestorableSession(reconstructed)
  if (!normalized || !canonicalEquals(reconstructed, normalized)) return
  const reencoded = await encodeSessionGraph(normalized)
  return graphMatches(reencoded, rootKey, persistedKeys, loaded) ? normalized : undefined
}

function graphMatches(
  reencoded: Awaited<ReturnType<typeof encodeSessionGraph>>,
  rootKey: string,
  persistedKeys: readonly string[],
  loaded: Map<string, string>,
): boolean {
  if (reencoded.sessionPartition !== rootKey
    || reencoded.partitionKeys.length !== persistedKeys.length
    || !reencoded.partitionKeys.every((key, index) => key === persistedKeys[index])
    || reencoded.partitionKeys.length !== loaded.size) return false
  return reencoded.partitionKeys.every((key) => loaded.get(key) === reencoded.partitions[key])
}

export async function decodeClientSnapshotV2(
  value: unknown,
  partitionProtocolVersion: 1 | undefined,
  loadPartition: (key: string) => Promise<string | null>,
): Promise<ClientSnapshotV1 | null> {
  const decoded = decodeRoot(value)
  if (!decoded || partitionProtocolVersion !== 1) return null
  try {
    const partition = await loadPartition(decoded.partitionKey)
    if (partition === null || encoder.encode(partition).byteLength > MAX_PARTITION_BYTES
      || await sha256(partition) !== decoded.partitionKey) return null
    const parsed = parseJson(partition)
    if (!parsed) return null
    if (isRecord(parsed.value) && parsed.value.format === 2) {
      const loaded = new Map([[decoded.partitionKey, partition]])
      const session = await decodeGraph(parsed.value, decoded.partitionKey, decoded.partitionKeys, loaded, loadPartition)
      return session === undefined ? null : { ...decoded.root, session }
    }
    return null
  } catch {
    return null
  }
}

export const isClientSnapshotV2 = (value: unknown): boolean => isRecord(value) && value.version === 2
