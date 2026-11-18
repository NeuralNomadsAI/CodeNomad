import type { OpenCodeConsoleUsage, ProviderUsageUnavailableReason } from "../../api-types-provider-usage"
import type { ProviderUsageWindow } from "../../api-types"
import { BoundedResponseError, fetchBoundedJson } from "../bounded-fetch"
import { openCodeConsoleCredential } from "../native-credentials"
import { ProviderHttpError } from "../shared"
import type { AuthFile, ProviderResult, UsageProvider } from "../types"
import { isOpenCodeFreeModel } from "../opencode-free-estimate"
import { parseOpenCodeConsoleBalance } from "../opencode-go-quota"

const BASE = "https://opencode.ai/console"
const PAGE_SIZE = 50
// A complete display read admits at most 20 pages / 1,000 model rows in 15s.
const MAX_PAGES = 20
const MAX_ROWS = PAGE_SIZE * MAX_PAGES
const METRICS = ["totalRequests", "totalInputTokens", "totalOutputTokens", "totalCacheReadTokens",
  "totalCacheWrite5mTokens", "totalCacheWrite1hTokens", "totalCostMicroCents"] as const

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoundedResponseError()
  return value as Record<string, unknown>
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new BoundedResponseError()
  return value
}

function decimal(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new BoundedResponseError()
  return integer(Number(value))
}

function metrics(value: Record<string, unknown>): number[] {
  return METRICS.map(key => decimal(value[key]))
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new BoundedResponseError()
  return value
}

export function parseOpenCodeConsoleSummary(payload: unknown): { requests: number; spentUsd: number } {
  const data = object(payload)
  const totals = metrics(data)
  if (!Array.isArray(data.services)) throw new BoundedResponseError()
  const sums = [0, 0]
  for (const value of data.services) {
    const service = object(value)
    text(service.service)
    sums[0] = integer(sums[0] + decimal(service.totalRequests))
    sums[1] = integer(sums[1] + decimal(service.totalCostMicroCents))
  }
  return { requests: totals[0], spentUsd: totals[6] / 100_000_000 }
}

export function parseOpenCodeConsoleModelsPage(payload: unknown, requestedPage: number) {
  const data = object(payload), info = object(data.pageInfo)
  const page = integer(info.page), pageSize = integer(info.pageSize)
  const total = integer(info.total), pageCount = integer(info.pageCount)
  if (!Array.isArray(data.items) || page !== requestedPage || page < 1 || pageSize !== PAGE_SIZE ||
    (total === 0 ? page !== 1 || pageCount > 1 : pageCount !== Math.ceil(total / PAGE_SIZE) || page > pageCount) ||
    data.items.length !== Math.min(PAGE_SIZE, Math.max(0, total - (page - 1) * PAGE_SIZE))) throw new BoundedResponseError()
  const totals = METRICS.map(() => 0)
  const models = data.items.map(value => {
    const item = object(value), values = metrics(item)
    values.forEach((count, index) => { totals[index] = integer(totals[index] + count) })
    return { provider: text(item.provider), model: text(item.model), requests: values[0] }
  })
  return { models, totals, pageCount, total }
}

async function readModels(range: "24h" | "30d", read: (path: string) => Promise<unknown>) {
  const models: OpenCodeConsoleUsage["models"] = []
  const totals = METRICS.map(() => 0)
  let expected: { total: number; pageCount: number } | undefined
  for (let page = 1; ; page++) {
    const parsed = parseOpenCodeConsoleModelsPage(await read(`usage/models?range=${range}&page=${page}&pageSize=${PAGE_SIZE}`), page)
    if (parsed.pageCount > MAX_PAGES || parsed.total > MAX_ROWS || (expected &&
      (expected.total !== parsed.total || expected.pageCount !== parsed.pageCount))) throw new BoundedResponseError()
    expected = parsed
    parsed.totals.forEach((count, index) => { totals[index] = integer(totals[index] + count) })
    models.push(...parsed.models)
    if (page >= parsed.pageCount) break
  }
  return models
}

/** Sum the Console's free-model counts. Failure stays unknown, never zero. */
export async function readOpenCodeConsoleFreeRequests(auth: AuthFile, signal: AbortSignal): Promise<number> {
  const credential = openCodeConsoleCredential(auth)
  if ("reason" in credential) throw new Error("Console credential unavailable")
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  const models = await readModels("24h", path => fetchBoundedJson(`${BASE}/api/${path}`, credential.headers, bounded))
  bounded.throwIfAborted()
  // The model's native provider can be an upstream vendor, rather than opencode.
  return models.filter(row => isOpenCodeFreeModel("opencode", row.model))
    .reduce((sum, row) => integer(sum + row.requests), 0)
}

/**
 * The optional Console credit balance. Every failure (including 401: the usage
 * reads already authenticate the same credential) only omits it.
 */
async function readOpenCodeConsoleCredits(auth: AuthFile, signal: AbortSignal): Promise<ProviderUsageWindow | undefined> {
  const credential = openCodeConsoleCredential(auth)
  if ("reason" in credential) return undefined
  try {
    return parseOpenCodeConsoleBalance(await fetchBoundedJson(`${BASE}/api/billing/status`, credential.headers,
      AbortSignal.any([signal, AbortSignal.timeout(3000)])))
  } catch {
    return undefined
  }
}

const BALANCE_GRACE_MS = 250

/**
 * Starts the optional balance read beside the usage reads. `settle` is awaited
 * once those reads are complete: it waits at most a short grace (or until
 * cancellation) and then omits the balance, so the optional read never spends
 * the caller's remaining budget or changes the reading's outcome.
 */
export function startOpenCodeConsoleCredits(auth: AuthFile, signal: AbortSignal) {
  const credits = readOpenCodeConsoleCredits(auth, signal)
  return {
    settle: () => new Promise<ProviderUsageWindow | undefined>(resolve => {
      const done = (value: ProviderUsageWindow | undefined) => {
        clearTimeout(timer); signal.removeEventListener("abort", omit); resolve(value)
      }
      const omit = () => done(undefined)
      const timer = setTimeout(omit, BALANCE_GRACE_MS)
      signal.addEventListener("abort", omit, { once: true })
      void credits.then(done)
    }),
  }
}

// Only stable codes survive; never retain upstream bodies or messages.
export function openCodeConsoleError(error: unknown): ProviderUsageUnavailableReason {
  return error instanceof ProviderHttpError
    ? error.status === 401 ? "opencode-console-invalid-credential"
      : error.status === 403 ? "opencode-console-access-denied" : "opencode-console-network-error"
    : error instanceof BoundedResponseError ? "opencode-console-invalid-response" : "opencode-console-network-error"
}

export const openCodeConsole: UsageProvider = {
  id: "opencode-console",
  name: "OpenCode Console",
  aliases: ["opencode", "opencode-console"],
  async fetchQuota(auth, context) {
    const base: ProviderResult = { providerId: this.id, providerName: this.name, ok: false,
      configured: true, usage: null, fetchedAt: Date.now() }
    const credential = openCodeConsoleCredential(auth)
    if ("reason" in credential) return { ...base, configured: credential.configured, unavailableReason: credential.reason }
    const bounded = context?.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    const read = (path: string) => fetchBoundedJson(`${BASE}/api/${path}`, credential.headers, bounded)
    const credits = startOpenCodeConsoleCredits(auth, bounded)
    try {
      const requests = {} as OpenCodeConsoleUsage["requests"]
      for (const range of ["24h", "7d", "30d"] as const) {
        requests[range] = parseOpenCodeConsoleSummary(await read(`usage/summary?range=${range}`)).requests
      }
      const models = await readModels("30d", read)
      const windows: NonNullable<ProviderResult["usage"]>["windows"] = {}
      bounded.throwIfAborted()
      const balance = await credits.settle()
      if (balance) windows.credits_balance = balance
      bounded.throwIfAborted()
      return { ...base, ok: true, usage: { windows, console: {
        requests, models, budgets: { status: "unavailable", items: [] },
      } } }
    } catch (error) {
      return { ...base, unavailableReason: openCodeConsoleError(error),
        ...(error instanceof ProviderHttpError ? { status: error.status } : {}) }
    }
  },
}
