import { z } from "zod"

export const dailyClockSchema = z.object({
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  zone: z.string().min(1).max(100).refine(zone => {
    // Offset strings are not a standing civil-time zone.
    if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false
    try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true } catch { return false }
  }),
}).strict()
export type DailyClock = z.infer<typeof dailyClockSchema>
export interface DailyDue { civilDay: string; at: number }
const MINUTE = 60_000
// Pure calendar calculations only, never admission/ledger state. Bounds repeated
// strict receipt validation to a small recent-day working set per incarnation.
const occurrences = new Map<string, DailyDue | null>()

function formatter(zone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, calendar: "iso8601", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
}
function civil(format: Intl.DateTimeFormat, at: number) {
  const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: `${parts.hour}:${parts.minute}` }
}

/** First UTC minute reaching the requested civil clock: gaps advance to the
 * first later minute, folds use the first occurrence, wholly skipped days have
 * no occurrence. Bounded minute search deliberately avoids an inverse-zone or
 * cron implementation. No dependence on the process's local timezone. */
export function dailyOccurrence(clockInput: DailyClock, civilDay: string): DailyDue | undefined {
  const clock = dailyClockSchema.parse(clockInput)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(civilDay)) throw new Error("Invalid recurrence civil day")
  const midnight = Date.parse(`${civilDay}T00:00:00Z`)
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== civilDay) throw new Error("Invalid recurrence civil day")
  const key = `${clock.zone}\0${clock.time}\0${civilDay}`
  const cached = occurrences.get(key)
  if (cached !== undefined) return cached ? { ...cached } : undefined
  const format = formatter(clock.zone)
  let due: DailyDue | undefined, observedDay = false
  // ponytail: bounded minute scan per cold day; optimize only if schedule volume makes startup slow.
  // All IANA offsets fall inside this 60-hour window (including date-line changes).
  for (let at = midnight - 18 * 60 * MINUTE; at <= midnight + 42 * 60 * MINUTE; at += MINUTE) {
    const local = civil(format, at)
    if (observedDay && local.day > civilDay) { due = { civilDay, at }; break }
    if (local.day === civilDay) observedDay = true
    if (local.day === civilDay && local.minute >= clock.time) { due = { civilDay, at }; break }
  }
  if (occurrences.size >= 128) occurrences.delete(occurrences.keys().next().value!)
  occurrences.set(key, due ?? null)
  return due ? { ...due } : undefined
}

/** Sleep/restart coalesces missed days to ONE latest due, not a backlog. The
 * caller must retain its original createdAt and daily high-water mark. */
export function latestDailyDue(clockInput: DailyClock, now: number): DailyDue {
  const clock = dailyClockSchema.parse(clockInput)
  if (!Number.isSafeInteger(now) || now < 0 || now > Date.parse("9999-12-28T00:00:00Z")) throw new Error("Invalid recurrence clock")
  const today = civil(formatter(clock.zone), now).day
  const midnight = Date.parse(`${today}T00:00:00Z`)
  // Includes a skipped whole civil day at the date line, without unbounded walks.
  for (let days = 0; days < 4; days++) {
    const day = new Date(midnight - days * 24 * 60 * MINUTE).toISOString().slice(0, 10)
    const due = dailyOccurrence(clock, day)
    if (due && due.at <= now) return due
  }
  throw new Error("Recurrence civil clock unavailable")
}

/** First future civil occurrence; skipped civil days have no passage. */
export function nextDailyDue(clockInput: DailyClock, now: number): DailyDue {
  const clock = dailyClockSchema.parse(clockInput)
  const today = civil(formatter(clock.zone), now).day
  const midnight = Date.parse(`${today}T00:00:00Z`)
  for (let days = 0; days < 4; days++) {
    const day = new Date(midnight + days * 86_400_000).toISOString().slice(0, 10)
    const due = dailyOccurrence(clock, day)
    if (due && due.at > now) return due
  }
  throw new Error("Recurrence civil clock unavailable")
}
