import { decodeClientSnapshot, normalizeRestorableSession } from "./client-state-codec"
import type { ClientSnapshotV1, RestorableSessionState, RestorableWorkspaceTabState } from "./client-state-codec"
import type { RestorableAttachment } from "./client-state-attachments-codec"

const MAX_PARTITION_BYTES = 1024 * 1024
const MAX_ROOT_BYTES = 1024 * 1024
const MAX_NATIVE_PARTITIONS = 4096
const MAX_NATIVE_COMMIT_BYTES = 256 * 1024 * 1024
const MAX_SESSION_ID = 512
const BLOB_CHUNK_CHARACTERS = 768 * 1024
const MAX_BLOB_CHUNKS = 256
const MAX_BLOB_BASE64_CHARACTERS = BLOB_CHUNK_CHARACTERS * MAX_BLOB_CHUNKS
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
  format: 2
  draft?: string
  attachments?: unknown[]
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

type AddPartition = (value: unknown) => Promise<string>

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
const validBase64 = (value: unknown): value is string => typeof value === "string"
  && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)

async function addBlob(data: string, addPartition: AddPartition): Promise<string[]> {
  if (!validBase64(data) || data.length > MAX_BLOB_BASE64_CHARACTERS) {
    throw new Error("Client state attachment exceeds the 192 MiB encoded blob limit")
  }
  const keys: string[] = []
  for (let offset = 0, index = 0; offset < data.length || offset === 0; offset += BLOB_CHUNK_CHARACTERS, index += 1) {
    keys.push(await addPartition({ format: 2, index, data: data.slice(offset, offset + BLOB_CHUNK_CHARACTERS) }))
  }
  return keys
}

async function encodeAttachments(attachments: RestorableAttachment[], addPartition: AddPartition): Promise<unknown[]> {
  return Promise.all(attachments.map(async (attachment) => {
    let source: Record<string, unknown>
    if (attachment.source.type === "file") {
      source = { type: "file", path: attachment.source.path, mime: attachment.source.mime }
      if (attachment.source.data !== undefined) source.dataPartitions = await addBlob(attachment.source.data, addPartition)
    } else if (attachment.source.type === "text") {
      source = {
        type: "text",
        valuePartitions: await addBlob(bytesToBase64(encoder.encode(attachment.source.value)), addPartition),
      }
    } else source = attachment.source
    return { ...attachment, source }
  }))
}

async function encodeSessionGraph(session: RestorableSessionState | null) {
  const generated: Record<string, string> = Object.create(null)
  const addPartition = async (value: unknown) => {
    const partition = canonicalJson(value)
    if (encoder.encode(partition).byteLength > MAX_PARTITION_BYTES) {
      throw new Error("Client state partition exceeds the native size limit")
    }
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
      const sessions: Record<string, { documentPartition: string; partitionKeys: string[] }> = Object.create(null)
      for (const sessionId of [...sessionIds].sort()) {
        const document: SessionDocument = { format: 2 }
        if (hasOwn(tab.drafts, sessionId)) document.draft = tab.drafts[sessionId]
        if (hasOwn(tab.attachments, sessionId)) {
          document.attachments = await encodeAttachments(tab.attachments[sessionId]!, addPartition)
        }
        if (hasOwn(tab.scrollSnapshots, sessionId)) document.scrollSnapshot = tab.scrollSnapshots[sessionId]
        if (hasOwn(tab.unseenIdleSince, sessionId)) document.unseenIdleSince = tab.unseenIdleSince[sessionId]
        if (hasOwn(tab.generationRecovery, sessionId)) document.generationRecovery = tab.generationRecovery[sessionId]
        const documentPartition = await addPartition(document)
        const attachmentPartitions = (document.attachments ?? []).flatMap((attachment) => {
          if (!isRecord(attachment) || !isRecord(attachment.source)) return []
          const keys = attachment.source.dataPartitions ?? attachment.source.valuePartitions
          return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : []
        })
        sessions[sessionId] = {
          documentPartition,
          partitionKeys: [...new Set([documentPartition, ...attachmentPartitions])].sort(),
        }
      }

      const workspace: Record<string, unknown> = { format: 2, sessions }
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

export function canCommitClientSnapshotV2(encoded: EncodedClientSnapshotV2): boolean {
  if (encoded.partitionKeys.length > MAX_NATIVE_PARTITIONS) return false
  const root = JSON.stringify(encoded.root)
  if (root.length > MAX_ROOT_BYTES) return false
  let commitBytes = encoder.encode(root).byteLength
  if (commitBytes > MAX_ROOT_BYTES) return false
  for (const key in encoded.partitions) {
    if (!hasOwn(encoded.partitions, key)) continue
    const partition = encoded.partitions[key]!
    if (partition.length > MAX_PARTITION_BYTES || partition.length > MAX_NATIVE_COMMIT_BYTES - commitBytes) return false
    const partitionBytes = encoder.encode(partition).byteLength
    if (partitionBytes > MAX_PARTITION_BYTES || partitionBytes > MAX_NATIVE_COMMIT_BYTES - commitBytes) return false
    commitBytes += partitionBytes
  }
  return true
}

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

  const sameKeys = (left: Iterable<string>, right: readonly string[]) => {
    const sorted = [...new Set(left)].sort()
    return sorted.length === right.length && sorted.every((key, index) => key === right[index])
  }
  const loadBlob = async (keys: unknown, allowed: ReadonlySet<string>, referenced: Set<string>) => {
    if (!Array.isArray(keys) || !keys.length || keys.length > MAX_BLOB_CHUNKS
      || !keys.every((key) => typeof key === "string" && PARTITION_KEY.test(key))
      || new Set(keys).size !== keys.length) return null
    const chunks: string[] = []
    let length = 0
    for (const [index, key] of (keys as string[]).entries()) {
      if (!allowed.has(key)) return null
      referenced.add(key)
      const chunk = await loadCanonical(key)
      if (!chunk || !validBase64(chunk.data)) return null
      if (chunk.format === 1) {
        if (!hasExactKeys(chunk, ["format", "data"])) return null
      } else if (chunk.format === 2) {
        if (!hasExactKeys(chunk, ["format", "index", "data"]) || chunk.index !== index) return null
      } else return null
      if (chunk.data.length > MAX_BLOB_BASE64_CHARACTERS - length) return null
      length += chunk.data.length
      chunks.push(chunk.data)
    }
    const data = chunks.join("")
    return validBase64(data) ? data : null
  }
  const decodeAttachments = async (
    value: unknown,
    allowed: ReadonlySet<string>,
    referenced: Set<string>,
  ): Promise<unknown[] | null> => {
    if (!Array.isArray(value)) return null
    const result: unknown[] = []
    for (const attachment of value) {
      if (!isRecord(attachment) || !hasExactKeys(attachment,
        ["id", "type", "display", "url", "filename", "mediaType", "source"]) || !isRecord(attachment.source)) return null
      const source = attachment.source
      if (source.type === "file") {
        if (!hasExactKeys(source, ["type", "path", "mime"], ["dataPartitions"])) return null
        if (hasOwn(source, "dataPartitions")) {
          const data = await loadBlob(source.dataPartitions, allowed, referenced)
          if (data === null) return null
          result.push({ ...attachment, source: { type: source.type, path: source.path, mime: source.mime, data } })
        } else result.push(attachment)
        continue
      }
      if (source.type === "text") {
        if (!hasExactKeys(source, ["type", "valuePartitions"])) return null
        const data = await loadBlob(source.valuePartitions, allowed, referenced)
        if (data === null) return null
        try {
          const value = new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(data))
          result.push({ ...attachment, source: { type: source.type, value } })
        } catch {
          return null
        }
        continue
      }
      result.push(attachment)
    }
    return result
  }

  const tabs: unknown[] = []
  const declaredGraph = new Set([rootKey])
  let degraded = false
  let legacyGraph = false
  for (const shell of manifest.session.tabs) {
    if (!isRecord(shell)) return
    if (shell.kind === "sidecar") {
      if (!hasExactKeys(shell, ["kind", "sidecarId"])) return
      tabs.push({ kind: shell.kind, sidecarId: shell.sidecarId })
      continue
    }
    if (shell.kind !== "workspace"
      || !hasExactKeys(shell, ["kind", "folder", "workspacePartition"], ["occurrence", "projectName", "binaryPath"])) return
    if (typeof shell.workspacePartition !== "string" || !PARTITION_KEY.test(shell.workspacePartition)) return
    declaredGraph.add(shell.workspacePartition)
    const workspace = await loadCanonical(shell.workspacePartition)
    if (!workspace || (workspace.format !== 1 && workspace.format !== 2)
      || !hasExactKeys(workspace, ["format", "sessions"],
        ["activeParentSessionId", "activeSessionId", "expandedSessionIds"])
      || !isRecord(workspace.sessions)) return
    legacyGraph ||= workspace.format === 1
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
    const entries: Array<{ sessionId: string; documentKey: string; partitionKeys: string[] }> = []
    for (const [sessionId, rawEntry] of Object.entries(workspace.sessions)) {
      if (workspace.format === 1) {
        if (typeof rawEntry !== "string" || !PARTITION_KEY.test(rawEntry)) return
        entries.push({ sessionId, documentKey: rawEntry, partitionKeys: [rawEntry] })
        declaredGraph.add(rawEntry)
        continue
      }
      if (!isRecord(rawEntry) || !hasExactKeys(rawEntry, ["documentPartition", "partitionKeys"])
        || typeof rawEntry.documentPartition !== "string" || !PARTITION_KEY.test(rawEntry.documentPartition)
        || !isPartitionKeyArray(rawEntry.partitionKeys)
        || !rawEntry.partitionKeys.includes(rawEntry.documentPartition)) return
      entries.push({ sessionId, documentKey: rawEntry.documentPartition, partitionKeys: rawEntry.partitionKeys })
      rawEntry.partitionKeys.forEach((key) => declaredGraph.add(key))
    }
    const activeId = typeof workspace.activeSessionId === "string" ? workspace.activeSessionId : undefined
    entries.sort((left, right) => left.sessionId === activeId ? -1 : right.sessionId === activeId ? 1
      : left.sessionId.localeCompare(right.sessionId))
    const dropped = new Set<string>()
    for (const { sessionId, documentKey, partitionKeys } of entries) {
      const document = await loadCanonical(documentKey)
      const allowed = new Set(partitionKeys)
      const referenced = new Set([documentKey])
      const validDocument = document && (document.format === 1 || document.format === 2)
        && hasExactKeys(document, ["format"],
          ["draft", "attachments", "scrollSnapshot", "unseenIdleSince", "generationRecovery"])
        && Object.keys(document).length > 1
      if (!validDocument) {
        degraded = true
        dropped.add(sessionId)
        continue
      }
      const decodedAttachments = !hasOwn(document, "attachments") ? undefined : document.format === 1
        ? document.attachments
        : await decodeAttachments(document.attachments, allowed, referenced)
      if ((hasOwn(document, "attachments") && decodedAttachments === null)
        || !sameKeys(referenced, partitionKeys)) {
        degraded = true
        dropped.add(sessionId)
        continue
      }
      const leaf: RestorableWorkspaceTabState = {
        kind: "workspace", folder: "/",
        drafts: Object.create(null), attachments: Object.create(null), scrollSnapshots: Object.create(null),
        unseenIdleSince: Object.create(null), generationRecovery: Object.create(null),
      }
      const fields = [
        ["draft", "drafts"],
        ["scrollSnapshot", "scrollSnapshots"],
        ["unseenIdleSince", "unseenIdleSince"],
        ["generationRecovery", "generationRecovery"],
      ] as const
      for (const [documentField, stateField] of fields) {
        if (hasOwn(document, documentField)) (leaf[stateField] as Record<string, unknown>)[sessionId] = document[documentField]
      }
      if (decodedAttachments !== undefined) leaf.attachments[sessionId] = decodedAttachments as RestorableAttachment[]
      const normalizedLeaf = normalizeRestorableSession({ tabs: [leaf], activeTabIndex: 0 })?.tabs[0]
      if (!normalizedLeaf || !canonicalEquals(leaf, normalizedLeaf)) {
        degraded = true
        dropped.add(sessionId)
        continue
      }
      for (const [, stateField] of fields) {
        if (hasOwn(leaf[stateField], sessionId)) {
          (tab[stateField] as Record<string, unknown>)[sessionId] = leaf[stateField][sessionId]
        }
      }
      if (hasOwn(leaf.attachments, sessionId)) {
        (tab.attachments as Record<string, unknown>)[sessionId] = leaf.attachments[sessionId]
      }
    }
    if (dropped.has(String(tab.activeSessionId))) delete tab.activeSessionId
    if (dropped.has(String(tab.activeParentSessionId))) delete tab.activeParentSessionId
    if (Array.isArray(tab.expandedSessionIds)) {
      tab.expandedSessionIds = tab.expandedSessionIds.filter((sessionId) => !dropped.has(String(sessionId)))
    }
    tabs.push(tab)
  }

  if (!sameKeys(declaredGraph, persistedKeys)) return

  const reconstructed: unknown = {
    tabs,
    activeTabIndex: manifest.session.activeTabIndex,
    ...(hasOwn(manifest.session, "homeActive") ? { homeActive: manifest.session.homeActive } : {}),
  }
  const normalized = normalizeRestorableSession(reconstructed)
  if (!normalized || !canonicalEquals(reconstructed, normalized)) return
  if (degraded || legacyGraph) return normalized
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
