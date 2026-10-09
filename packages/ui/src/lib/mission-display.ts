/** Display-only helpers for the Missions panel. They never change mission state. */

const SENTENCE_END = /[.!?。！？](?=\s|$)|\n/u
const CLAUSE_END = /[,;:，；：—–]/gu

/** An explicit title wins; otherwise the first sentence/clause of the objective. */
export function missionDisplayTitle(mission: { objective: string; title?: string }, max = 60): string {
  const explicit = mission.title?.replace(/\s+/g, " ").trim()
  return explicit || missionShortTitle(mission.objective, max)
}

export function missionShortTitle(text: string, max = 60): string {
  const firstLine = text.trim().split(SENTENCE_END)[0] ?? ""
  const sentence = firstLine.replace(/\s+/g, " ").trim().replace(/[.!?。！？]+$/u, "")
  const points = Array.from(sentence)
  if (points.length <= max) return sentence
  const head = points.slice(0, max).join("")
  let clause = -1
  for (const match of head.matchAll(CLAUSE_END)) if ((match.index ?? 0) >= max / 3) clause = match.index ?? -1
  if (clause > 0) return head.slice(0, clause).trimEnd() + "…"
  const word = head.slice(0, max - 1).lastIndexOf(" ")
  return (word >= max / 3 ? head.slice(0, word) : Array.from(head).slice(0, max - 1).join("")).trimEnd() + "…"
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [["minute", 60], ["hour", 3_600], ["day", 86_400]]

/** "2 hours ago"; dates older than a week use the medium date. */
export function missionRelativeTime(at: number, locale: string, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000)
  const absolute = Math.abs(seconds)
  if (absolute >= 7 * 86_400) return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  if (absolute < 60) return format.format(0, "second")
  const [unit, size] = [...UNITS].reverse().find(([, size]) => absolute >= size)!
  return format.format(Math.trunc(seconds / size), unit)
}

function civilDay(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(at)
  const part = (type: string) => Number(parts.find(item => item.type === type)?.value)
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000
}

function zoneOffset(zone: string, at: number): string | undefined {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at)
    .find(part => part.type === "timeZoneName")?.value
}

/** A schedule zone needs a label only when its rules differ from the viewer's zone. */
export function missionZoneDiffers(zone: string, userZone = Intl.DateTimeFormat().resolvedOptions().timeZone, at = Date.now()): boolean {
  if (zone === userZone) return false
  try { return [at, at + 182 * 86_400_000].some(instant => zoneOffset(zone, instant) !== zoneOffset(userZone, instant)) }
  catch { return true }
}

/** Short localized zone name ("UTC", "GMT+2"), falling back to the IANA name. */
export function missionZoneName(zone: string, locale: string, at = Date.now()): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" }).formatToParts(at)
      .find(part => part.type === "timeZoneName")?.value ?? zone
  } catch { return zone }
}

/** A daily "HH:MM" civil clock formatted like every other schedule time. */
export function missionClockTime(time: string, locale: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) return time
  return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2])))
}

/** "today"/"tomorrow" (or the date) and the time, both in the schedule's zone. */
export function missionScheduleWhen(at: number, zone: string, locale: string, now = Date.now()): { day: string; time: string } {
  let distance = Number.NaN
  try { distance = civilDay(at, zone) - civilDay(now, zone) } catch { /* Unknown zone: fall back to the date. */ }
  const options = { timeZone: zone }
  let day: string, time: string
  try {
    day = distance === 0 || distance === 1 ? new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(distance, "day")
      : new Intl.DateTimeFormat(locale, { ...options, dateStyle: "medium" }).format(at)
    time = new Intl.DateTimeFormat(locale, { ...options, timeStyle: "short" }).format(at)
  } catch {
    day = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at)
    time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(at)
  }
  return { day, time }
}
