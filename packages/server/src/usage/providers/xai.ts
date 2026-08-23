import { getAuthEntry, getString, notConfigured, oauthTokenNeedsRefresh, result, toUsageWindow, writeOpenCodeAuthEntry } from "../shared"
import type { AuthEntry, UsageProvider } from "../types"

const USAGE_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const REQUEST_TIMEOUT_MS = 15_000
const EMPTY_GRPC_WEB_BODY = new Uint8Array([0, 0, 0, 0, 0])
const USAGE_PERCENT_PATHS = [[1], [1, 1]]

type ScanState = { index: number; order: number }
type Fixed32Field = { path: number[]; value: number; order: number }
type VarintField = { path: number[]; value: bigint }
type ProtobufScan = { fixed32Fields: Fixed32Field[]; varintFields: VarintField[] }

let refreshPromise: Promise<AuthEntry> | null = null

async function refreshXaiOauth(entry: AuthEntry): Promise<AuthEntry> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = getString(entry.refresh)
      if (!refreshToken) throw new Error("xAI OAuth entry has no usable refresh token")
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT_ID, refresh_token: refreshToken, grant_type: "refresh_token" }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`xAI OAuth refresh failed with HTTP ${response.status}`)
      const payload = await response.json() as Record<string, unknown>
      const access = getString(payload.access_token)
      if (!access) throw new Error("xAI OAuth refresh returned no access token")
      const expiresIn = Number(payload.expires_in ?? 3600)
      if (!Number.isFinite(expiresIn)) throw new Error("xAI OAuth refresh returned an invalid expiry")
      const refreshed: AuthEntry = {
        ...entry,
        type: "oauth",
        access,
        refresh: getString(payload.refresh_token) ?? refreshToken,
        expires: Date.now() + expiresIn * 1000,
      }
      writeOpenCodeAuthEntry("xai", refreshed)
      return refreshed
    })().finally(() => { refreshPromise = null })
  }
  return refreshPromise
}

async function ensureFreshAccess(entry: AuthEntry): Promise<string> {
  const fresh = oauthTokenNeedsRefresh(entry) ? await refreshXaiOauth(entry) : entry
  const access = getString(fresh.access)
  if (!access) throw new Error("xAI OAuth entry has no usable access token")
  return access
}

function readVarint(bytes: Uint8Array, state: ScanState): bigint | null {
  let value = 0n
  for (let shift = 0n; state.index < bytes.length && shift < 64n; shift += 7n) {
    const byte = bytes[state.index++]
    if (shift === 63n && (byte & 0x7e) !== 0) return null
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return value
  }
  return null
}

function samePath(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function scanProtobuf(bytes: Uint8Array, path: number[] = [], depth = 0, state: ScanState = { index: 0, order: 0 }): ProtobufScan | null {
  const fixed32Fields: Fixed32Field[] = []
  const varintFields: VarintField[] = []
  while (state.index < bytes.length) {
    const key = readVarint(bytes, state)
    if (key === null || key === 0n) return null
    const fieldNumber = Number(key >> 3n)
    const wireType = Number(key & 0x07n)
    if (!fieldNumber || fieldNumber > 0x1fffffff) return null
    const fieldPath = [...path, fieldNumber]
    if (wireType === 0) {
      const value = readVarint(bytes, state)
      if (value === null) return null
      varintFields.push({ path: fieldPath, value })
      continue
    }
    if (wireType === 1) {
      if (state.index + 8 > bytes.length) return null
      state.index += 8
      continue
    }
    if (wireType === 2) {
      const length = readVarint(bytes, state)
      if (length === null || length > BigInt(bytes.length - state.index)) return null
      const end = state.index + Number(length)
      if (depth >= 4 && length !== 0n) return null
      if (depth < 4) {
        const nestedState = { index: 0, order: state.order }
        const nested = scanProtobuf(bytes.slice(state.index, end), fieldPath, depth + 1, nestedState)
        if (!nested) return null
        fixed32Fields.push(...nested.fixed32Fields)
        varintFields.push(...nested.varintFields)
        state.order = nestedState.order
      }
      state.index = end
      continue
    }
    if (wireType === 5) {
      if (state.index + 4 > bytes.length) return null
      fixed32Fields.push({
        path: fieldPath,
        value: Buffer.from(bytes.slice(state.index, state.index + 4)).readFloatLE(0),
        order: state.order++,
      })
      state.index += 4
      continue
    }
    return null
  }
  return { fixed32Fields, varintFields }
}

function parseGrpcTrailerStatus(bytes: Uint8Array): number | null {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  let status: number | null = null
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    const separator = line.indexOf(":")
    if (separator <= 0) return null
    if (line.slice(0, separator).trim().toLowerCase() !== "grpc-status") continue
    if (status !== null) return null
    const value = line.slice(separator + 1).trim()
    if (!/^\d+$/.test(value)) return null
    status = Number(value)
  }
  return status
}

function parseFrames(bytes: Uint8Array): { messages: Uint8Array[]; trailerStatuses: number[] } | null | false {
  if (bytes.length < 5 || (bytes[0] & 0x7f) !== 0) return null
  const messages: Uint8Array[] = []
  const trailerStatuses: number[] = []
  let trailerStarted = false
  let index = 0
  while (index < bytes.length) {
    if (index + 5 > bytes.length) return false
    const flags = bytes[index++]
    if ((flags & 0x7f) !== 0) return false
    const trailer = (flags & 0x80) !== 0
    if (trailerStarted && !trailer) return false
    const length = (bytes[index] * 0x1000000) + (bytes[index + 1] << 16) + (bytes[index + 2] << 8) + bytes[index + 3]
    index += 4
    const end = index + length
    if (end > bytes.length) return false
    const payload = bytes.slice(index, end)
    if (trailer) {
      trailerStarted = true
      const status = parseGrpcTrailerStatus(payload)
      if (status === null) return false
      trailerStatuses.push(status)
    } else {
      messages.push(payload)
    }
    index = end
  }
  return { messages, trailerStatuses }
}

function looksLikeProtobuf(bytes: Uint8Array): boolean {
  if (!bytes.length) return false
  return bytes[0] >> 3 > 0 && [0, 1, 2, 5].includes(bytes[0] & 0x07)
}

export function parseXaiUsage(bytes: Uint8Array): { usedPercent: number; resetAt: number | null } {
  const framed = parseFrames(bytes)
  if (framed === false) throw new Error("xAI billing returned malformed gRPC-web framing")
  const payloads = framed ? framed.messages : looksLikeProtobuf(bytes) ? [bytes] : []
  if (framed?.trailerStatuses.some((status) => status !== 0)) {
    throw new Error(`xAI billing RPC failed with status ${framed.trailerStatuses.find((status) => status !== 0)}`)
  }
  if (!payloads.length) throw new Error("xAI billing returned an empty protobuf response")
  const scan: ProtobufScan = { fixed32Fields: [], varintFields: [] }
  for (const payload of payloads) {
    const current = scanProtobuf(payload)
    if (!current) throw new Error("xAI billing returned malformed protobuf")
    scan.fixed32Fields.push(...current.fixed32Fields)
    scan.varintFields.push(...current.varintFields)
  }
  const percentages = scan.fixed32Fields
    .filter((field) => USAGE_PERCENT_PATHS.some((path) => samePath(path, field.path)) && Number.isFinite(field.value) && field.value >= 0 && field.value <= 100)
    .sort((left, right) => left.path.length - right.path.length || left.order - right.order)
  const resets = scan.varintFields
    .filter((field) => field.value >= 1_700_000_000n && field.value <= 2_100_000_000n)
    .map((field) => ({ ...field, resetAt: Number(field.value) * 1000 }))
    .filter((field) => field.resetAt > Date.now())
  const preferred = resets.filter((field) => samePath(field.path, [1, 5, 1]))
  const resetAt = (preferred.length ? preferred : resets).sort((left, right) => left.resetAt - right.resetAt)[0]?.resetAt ?? null
  const usedPercent = percentages[0]?.value
  const hasUsagePeriod = scan.varintFields.some((field) => (
    (field.path.length >= 2 && field.path[0] === 1 && field.path[1] === 6)
    || (samePath(field.path, [1, 8, 1]) && (field.value === 1n || field.value === 2n))
  ))
  if (usedPercent === undefined && !scan.fixed32Fields.length && resetAt !== null && hasUsagePeriod) return { usedPercent: 0, resetAt }
  if (usedPercent === undefined) throw new Error("xAI billing response had no usable current-period usage")
  return { usedPercent, resetAt }
}

async function fetchUsage(accessToken: string) {
  const response = await fetch(USAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Origin: "https://grok.com",
      Referer: "https://grok.com/?_s=usage",
      Accept: "*/*",
      "Content-Type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      "x-user-agent": "connect-es/2.1.1",
      "User-Agent": "CodeNomad",
    },
    body: EMPTY_GRPC_WEB_BODY,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const headerStatus = response.headers.get("grpc-status")
  if (headerStatus !== null && (!/^\d+$/.test(headerStatus.trim()) || Number(headerStatus) !== 0)) {
    throw new Error(`xAI billing RPC failed with status ${headerStatus}`)
  }
  if (!response.ok) throw new Error(`xAI billing request failed with HTTP ${response.status}`)
  return parseXaiUsage(new Uint8Array(await response.arrayBuffer()))
}

const xai: UsageProvider = {
  id: "xai",
  name: "xAI",
  aliases: ["xai", "grok"],
  async fetchQuota() {
    const entry = getAuthEntry(this.aliases)
    if (!entry || entry.type !== "oauth") return notConfigured(this.id, this.name)
    try {
      const usage = await fetchUsage(await ensureFreshAccess(entry))
      return result(this.id, this.name, {
        ok: true,
        configured: true,
        usage: { windows: { billing_cycle: toUsageWindow({ usedPercent: usage.usedPercent, resetAt: usage.resetAt }) } },
      })
    } catch (error) {
      return result(this.id, this.name, {
        ok: false,
        configured: true,
        error: error instanceof Error ? error.message : "Request failed",
      })
    }
  },
}

export const xaiProviders: UsageProvider[] = [xai]
