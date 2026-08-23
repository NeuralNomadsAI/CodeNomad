import fs from "fs"
import os from "os"
import path from "path"

import type { ProviderUsageWindow } from "../api-types"
import type { AuthEntry, AuthFile, ProviderResult, ProviderUsage } from "./types"

const REQUEST_TIMEOUT_MS = 15_000

function authFileCandidates(): string[] {
  const home = os.homedir()
  const candidates = [
    process.env.OPENCODE_AUTH_FILE,
    process.env.OPENCODE_DATA_DIR ? path.join(process.env.OPENCODE_DATA_DIR, "auth.json") : undefined,
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json") : undefined,
    path.join(home, ".local", "share", "opencode", "auth.json"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "opencode", "Data", "auth.json") : undefined,
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode", "auth.json") : undefined,
    path.join(home, "Library", "Application Support", "opencode", "auth.json"),
  ]
  return Array.from(new Set(candidates.filter((candidate): candidate is string => Boolean(candidate))))
}

function readAuthCandidate(): { auth: AuthFile; file: string } | null {
  for (const file of authFileCandidates()) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { auth: parsed as AuthFile, file }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue
    }
  }
  return null
}

export function readOpenCodeAuth(): AuthFile {
  return readAuthCandidate()?.auth ?? {}
}

export function writeOpenCodeAuthEntry(providerId: string, entry: AuthEntry): void {
  const current = readAuthCandidate()
  const file = current?.file ?? authFileCandidates()[0]
  if (!file) throw new Error("OpenCode auth file is unavailable")
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...(current?.auth ?? {}), [providerId]: entry }, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch { /* best effort */ }
  }
}

export function getAuthEntry(aliases: readonly string[]): AuthEntry | null {
  const auth = readOpenCodeAuth()
  for (const alias of aliases) {
    const value = auth[alias]
    if (typeof value === "string" && value.trim()) return { token: value.trim() }
    if (value && typeof value === "object" && !Array.isArray(value)) return value as AuthEntry
  }
  return null
}

export function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function getCredential(aliases: readonly string[], fields: readonly string[]): string | null {
  const entry = getAuthEntry(aliases)
  if (!entry) return null
  for (const field of fields) {
    const value = getString(entry[field])
    if (value) return value
  }
  return null
}

export function decodeJwtClaims(token: string): Record<string, any> | null {
  try {
    const payload = token.split(".")[1]
    return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : null
  } catch {
    return null
  }
}

export function oauthTokenNeedsRefresh(entry: AuthEntry, skewMs = 120_000): boolean {
  const access = getString(entry.access)
  if (!access) return true
  const deadline = Date.now() + skewMs
  const storedExpiry = Number(entry.expires)
  if (Number.isFinite(storedExpiry) && storedExpiry <= deadline) return true
  const jwtExpiry = Number(decodeJwtClaims(access)?.exp) * 1000
  return Number.isFinite(jwtExpiry) && jwtExpiry <= deadline
}

export function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function toTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function toUsageWindow(input: {
  usedPercent: number | null
  windowSeconds?: number | null
  resetAt?: number | null
  valueLabel?: string | null
}): ProviderUsageWindow {
  const usedPercent = input.usedPercent === null ? null : Math.max(0, Math.min(100, input.usedPercent))
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    windowSeconds: input.windowSeconds ?? null,
    resetAt: input.resetAt ?? null,
    ...(input.valueLabel ? { valueLabel: input.valueLabel } : {}),
  }
}

export function resolveWindowLabel(windowSeconds: number | null): string {
  if (!windowSeconds) return "usage"
  if (windowSeconds % 86_400 === 0) {
    const days = windowSeconds / 86_400
    return days === 7 ? "weekly" : `${days}d`
  }
  if (windowSeconds % 3600 === 0) return `${windowSeconds / 3600}h`
  return `${windowSeconds}s`
}

export function result(
  providerId: string,
  providerName: string,
  input: { ok: boolean; configured: boolean; usage?: ProviderUsage; error?: string },
): ProviderResult {
  return {
    providerId,
    providerName,
    ok: input.ok,
    configured: input.configured,
    usage: input.usage ?? null,
    fetchedAt: Date.now(),
    ...(input.error ? { error: input.error } : {}),
  }
}

export function notConfigured(providerId: string, providerName: string): ProviderResult {
  return result(providerId, providerName, { ok: false, configured: false, error: "Not configured" })
}

export async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`)
  return response.json()
}

export async function safeFetch(
  providerId: string,
  providerName: string,
  operation: () => Promise<ProviderUsage>,
): Promise<ProviderResult> {
  try {
    return result(providerId, providerName, { ok: true, configured: true, usage: await operation() })
  } catch (error) {
    return result(providerId, providerName, {
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : "Request failed",
    })
  }
}
