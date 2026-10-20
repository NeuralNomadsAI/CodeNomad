import { z } from "zod"
import type { SettingsService } from "../settings/service"
import type { ServiceUsageSnapshot } from "../api-types"

export const usagePeriods = [7, 30, 90, 365] as const
const number = z.number().finite().nonnegative()
const tokens = z.object({ input: number, output: number, reasoning: number, cache: z.object({ read: number, write: number }) })
const snapshot = z.object({ scope: z.literal("service"), stats: z.object({
  range: z.object({ from: number, to: number }), sessions: number, subagents: number, prompts: number, steps: number,
  tokens, cost: number, tools: z.object({ mode: z.literal("none") }), activeDays: number, streak: number,
  models: z.array(z.object({ model: z.object({ providerID: z.string().max(256), id: z.string().max(256), variant: z.string().max(256).optional() }),
    steps: number, tokens, cost: number })).max(256),
  activity: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), steps: number })).max(366),
}) }).refine(value => value.stats.range.to > value.stats.range.from && value.stats.range.to - value.stats.range.from <= 366 * 86_400_000)
const entry = z.object({ identity: z.string().regex(/^[a-f0-9]{64}$/), days: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]),
  timezone: z.string().min(1).max(128).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true } catch { return false } }), snapshot })
  .refine(value => value.snapshot.stats.range.to - value.snapshot.stats.range.from === value.days * 86_400_000)
type Entry = z.infer<typeof entry>
type Settings = Pick<SettingsService, "getOwner" | "mergePatchOwner">

/** Optional display-only UI state, not native client-state or mutation authority.
 * The backend is the sole Stats writer, including for secondary Preferences windows. */
export class ServiceUsageCache {
  constructor(private readonly settings: Settings) {}
  private entries(): Entry[] {
    const value = this.settings.getOwner("state", "ui").serviceUsage as { version?: unknown; entries?: unknown } | undefined
    if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 8) return []
    try { if (Buffer.byteLength(JSON.stringify(value.entries)) > 1_048_576) return [] }
    catch { return [] }
    return value.entries.flatMap(value => {
      const parsed = entry.safeParse(value)
      return parsed.success ? [parsed.data] : []
    })
  }
  get(identity: string, timezone: string, days?: number) {
    const saved = this.entries().find(value => value.identity === identity && value.timezone === timezone && (days === undefined || value.days === days))
    return { days: days ?? saved?.days ?? 30, snapshot: saved?.snapshot as ServiceUsageSnapshot | undefined }
  }
  set(identity: string, timezone: string, days: number, snapshot: ServiceUsageSnapshot) {
    const parsed = entry.safeParse({ identity, timezone, days, snapshot })
    if (!parsed.success) return
    const previous = this.entries()
    if (previous.some(value => value.identity === identity && value.timezone === timezone && value.days === days
      && value.snapshot.stats.range.to > snapshot.stats.range.to)) return
    const entries = [parsed.data, ...previous.filter(value => !(value.identity === identity && value.timezone === timezone && value.days === days))].slice(0, 8)
    // ponytail: bounded last-eight display snapshots, evict oldest rather than partitioning aggregates.
    while (entries.length && Buffer.byteLength(JSON.stringify(entries)) > 1_048_576) entries.pop()
    if (!entries.length) return
    this.settings.mergePatchOwner("state", "ui", { serviceUsage: { version: 1, entries } })
  }
}
