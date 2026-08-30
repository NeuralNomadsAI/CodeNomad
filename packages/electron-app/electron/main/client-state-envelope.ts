import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import {
  CLIENT_STATE_PARTITION_ENVELOPE_VERSION,
  CLIENT_STATE_PARTITION_PROTOCOL_VERSION,
  MAX_CLIENT_STATE_ROOT_BYTES,
  validateClientStatePartitionRoot,
  validatePartitionKeys,
} from "./client-state-partitions"
import { normalizeNativeWindowState, type NativeWindowState } from "./window-state"

export const CLIENT_STATE_MONOLITHIC_VERSION = 1
export const CLIENT_STATE_ENVELOPE_VERSION = 3
export const MAX_CLIENT_SNAPSHOT_BYTES = 1024 * 1024
export const MAX_CLIENT_STATE_WINDOWS = 16

export interface ClientWindowStateRecord {
  restoreEnabled: boolean
  snapshot?: unknown
  window?: NativeWindowState
  partitionProtocolVersion?: typeof CLIENT_STATE_PARTITION_PROTOCOL_VERSION
  partitionKeys?: string[]
}

export interface PersistedClientState {
  version: typeof CLIENT_STATE_ENVELOPE_VERSION
  activeWindowId: string
  windowOrder: string[]
  windows: Record<string, ClientWindowStateRecord>
}

export interface ParsedClientState {
  state: PersistedClientState
  unsupportedFutureEnvelope: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))

export function isWindowId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value)
}

export function createClientState(windowId: string = randomUUID()): PersistedClientState {
  if (!isWindowId(windowId)) throw new TypeError("Invalid client state window ID")
  return {
    version: CLIENT_STATE_ENVELOPE_VERSION,
    activeWindowId: windowId,
    windowOrder: [windowId],
    windows: { [windowId]: { restoreEnabled: true } },
  }
}

export function deterministicLegacyWindowId(content: string | Buffer): string {
  const bytes = createHash("sha256").update(content).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function strictWindowState(value: unknown): NativeWindowState | undefined {
  const normalized = normalizeNativeWindowState(value)
  return normalized && isDeepStrictEqual(value, normalized) ? normalized : undefined
}

function snapshotSize(value: unknown): number | undefined {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8")
}

function parseRecord(value: unknown): ClientWindowStateRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!hasOnlyKeys(record, ["restoreEnabled", "snapshot", "window", "partitionProtocolVersion", "partitionKeys"])
    || typeof record.restoreEnabled !== "boolean") return undefined

  const window = hasOwn(record, "window") ? strictWindowState(record.window) : undefined
  if (hasOwn(record, "window") && !window) return undefined
  const hasProtocol = hasOwn(record, "partitionProtocolVersion")
  const hasPartitionKeys = hasOwn(record, "partitionKeys")
  const size = hasOwn(record, "snapshot") ? snapshotSize(record.snapshot) : undefined
  if (hasOwn(record, "snapshot") && size === undefined) return undefined

  let partitionKeys: string[] | undefined
  if (hasProtocol || hasPartitionKeys) {
    partitionKeys = validatePartitionKeys(record.partitionKeys)
    const rootKeys = validateClientStatePartitionRoot(record.snapshot)
    if (!hasProtocol || !hasPartitionKeys
      || record.partitionProtocolVersion !== CLIENT_STATE_PARTITION_PROTOCOL_VERSION
      || !hasOwn(record, "snapshot") || !partitionKeys || !rootKeys
      || size! > MAX_CLIENT_STATE_ROOT_BYTES
      || rootKeys.length !== partitionKeys.length
      || rootKeys.some((key, index) => key !== partitionKeys![index])) return undefined
  } else if (size !== undefined && size > MAX_CLIENT_SNAPSHOT_BYTES) {
    return undefined
  }

  return {
    restoreEnabled: record.restoreEnabled,
    ...(hasOwn(record, "snapshot") ? { snapshot: record.snapshot } : {}),
    ...(window ? { window } : {}),
    ...(partitionKeys ? {
      partitionProtocolVersion: CLIENT_STATE_PARTITION_PROTOCOL_VERSION,
      partitionKeys,
    } : {}),
  }
}

function parseV3(envelope: Record<string, unknown>): PersistedClientState | undefined {
  if (!hasOnlyKeys(envelope, ["version", "activeWindowId", "windowOrder", "windows"])
    || !isWindowId(envelope.activeWindowId)
    || !Array.isArray(envelope.windowOrder)
    || envelope.windowOrder.length > MAX_CLIENT_STATE_WINDOWS
    || !envelope.windows || typeof envelope.windows !== "object" || Array.isArray(envelope.windows)) return undefined

  const windowOrder = envelope.windowOrder
  if (windowOrder.some((id) => !isWindowId(id)) || new Set(windowOrder).size !== windowOrder.length
    || (windowOrder.length > 0 && !windowOrder.includes(envelope.activeWindowId))) return undefined
  const source = envelope.windows as Record<string, unknown>
  if (Object.keys(source).length !== windowOrder.length || Object.keys(source).some((id) => !windowOrder.includes(id))) return undefined
  const windows: Record<string, ClientWindowStateRecord> = {}
  for (const id of windowOrder) {
    if (!hasOwn(source, id)) return undefined
    const record = parseRecord(source[id])
    if (!record) return undefined
    windows[id] = record
  }
  return {
    version: CLIENT_STATE_ENVELOPE_VERSION,
    activeWindowId: envelope.activeWindowId,
    windowOrder: [...windowOrder],
    windows,
  }
}

function parseLegacy(envelope: Record<string, unknown>, windowId: string): PersistedClientState | undefined {
  const version = envelope.version
  if (version === CLIENT_STATE_PARTITION_ENVELOPE_VERSION) {
    if (!hasOnlyKeys(envelope, ["version", "restoreEnabled", "snapshot", "window", "protocolVersion", "partitionKeys"])
      || typeof envelope.restoreEnabled !== "boolean"
      || envelope.protocolVersion !== CLIENT_STATE_PARTITION_PROTOCOL_VERSION
      || !hasOwn(envelope, "snapshot")) return undefined
    const partitionKeys = validatePartitionKeys(envelope.partitionKeys)
    const rootKeys = validateClientStatePartitionRoot(envelope.snapshot)
    const window = hasOwn(envelope, "window") ? strictWindowState(envelope.window) : undefined
    const size = snapshotSize(envelope.snapshot)
    if (!partitionKeys || !rootKeys || size === undefined || size > MAX_CLIENT_STATE_ROOT_BYTES
      || rootKeys.length !== partitionKeys.length
      || rootKeys.some((key, index) => key !== partitionKeys[index])
      || (hasOwn(envelope, "window") && !window)) return undefined
    return {
      version: CLIENT_STATE_ENVELOPE_VERSION,
      activeWindowId: windowId,
      windowOrder: [windowId],
      windows: { [windowId]: {
        restoreEnabled: envelope.restoreEnabled,
        snapshot: envelope.snapshot,
        ...(window ? { window } : {}),
        partitionProtocolVersion: CLIENT_STATE_PARTITION_PROTOCOL_VERSION,
        partitionKeys,
      } },
    }
  }

  if (version !== CLIENT_STATE_MONOLITHIC_VERSION
    || !hasOnlyKeys(envelope, ["version", "restoreEnabled", "snapshot", "window"])
    || (hasOwn(envelope, "restoreEnabled") && typeof envelope.restoreEnabled !== "boolean")) return undefined
  const window = hasOwn(envelope, "window") ? strictWindowState(envelope.window) : undefined
  const size = hasOwn(envelope, "snapshot") ? snapshotSize(envelope.snapshot) : undefined
  if ((hasOwn(envelope, "snapshot") && (size === undefined || size > MAX_CLIENT_SNAPSHOT_BYTES))
    || (hasOwn(envelope, "window") && !window)) return undefined
  return {
    version: CLIENT_STATE_ENVELOPE_VERSION,
    activeWindowId: windowId,
    windowOrder: [windowId],
    windows: { [windowId]: {
      restoreEnabled: typeof envelope.restoreEnabled === "boolean" ? envelope.restoreEnabled : true,
      ...(hasOwn(envelope, "snapshot") ? { snapshot: envelope.snapshot } : {}),
      ...(window ? { window } : {}),
    } },
  }
}

export function parseClientState(value: string, legacyWindowId?: string): ParsedClientState {
  try {
    const candidate = JSON.parse(value) as unknown
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError("Invalid client state envelope")
    const envelope = candidate as Record<string, unknown>
    const state = envelope.version === CLIENT_STATE_ENVELOPE_VERSION
      ? parseV3(envelope)
      : parseLegacy(envelope, legacyWindowId ?? deterministicLegacyWindowId(value))
    if (!state) throw new TypeError("Invalid client state envelope")
    return { state, unsupportedFutureEnvelope: false }
  } catch (error) {
    console.warn("[client-state] unsupported state file", error)
    const fallbackWindowId = legacyWindowId ?? randomUUID()
    const state = createClientState(fallbackWindowId)
    state.windows[fallbackWindowId]!.restoreEnabled = false
    return { state, unsupportedFutureEnvelope: true }
  }
}

export function retainedPartitionKeys(state: PersistedClientState): string[] {
  return [...new Set(state.windowOrder.flatMap((id) => state.windows[id]!.partitionKeys ?? []))].sort()
}
