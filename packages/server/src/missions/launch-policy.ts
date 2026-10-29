import { Cron } from "effect"
import { z } from "zod"
import { authorityRootSchema, canonicalAuthority } from "./authority-protocol"
import { MISSION_TITLE_MAX, MISSION_TITLE_PATTERN } from "./mission-title"
import { compareModelError, missionProfileRoles, missionProfilesInputSchema, validateMissionProfiles } from "./playbook-profiles"
import { missionTaskModeInputSchema } from "./task-execution-mode"

export const MISSION_DOCUMENT_MAX_BYTES = 256 * 1024
export const MISSION_CONFIGURATION_MAX_BYTES = 64 * 1024
export const MISSION_CALENDAR_LIMIT = 8
export const MISSION_MIN_INTERVAL_MS = 15 * 60_000
export const documentID = z.string().regex(/^[A-Za-z0-9_-]{3,100}$/)
export const nativeDocumentID = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/)
export const documentCounter = z.number().int().nonnegative().safe()
export const documentTimestamp = documentCounter.max(Date.parse("9999-12-28T00:00:00Z"))
const duration = z.number().int().positive().safe().max(documentTimestamp.maxValue!)
const zone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true } catch { return false }
}, "Invalid IANA time zone")
const cron = z.object({ expression: z.string().trim().min(1).max(512).transform(value => value.replace(/\s+/g, " ")), zone }).strict().refine(value => {
  // One second position per minute bounds frequency. Native preview/next-occurrence
  // qualification belongs to the calendar adapter, rather than a second time engine.
  try { return Cron.parseUnsafe(value.expression, value.zone).seconds.size === 1 } catch { return false }
}, "Invalid minute-resolution cron")

export const missionTimingSchema = z.union([
  z.object({ kind: z.literal("immediate") }).strict(),
  z.object({ kind: z.literal("at"), at: documentTimestamp, zone }).strict(),
  z.object({ kind: z.literal("in"), delayMs: duration }).strict(),
  z.object({ kind: z.literal("every"), intervalMs: duration.min(MISSION_MIN_INTERVAL_MS) }).strict(),
  z.object({ kind: z.literal("cron"), expression: z.string(), zone: z.string() }).strict()
    .transform(({ kind, ...value }, context) => {
      const parsed = cron.safeParse(value)
      if (!parsed.success) { context.addIssue({ code: "custom", message: "Invalid minute-resolution cron" }); return z.NEVER }
      return { kind, ...parsed.data }
    }),
  z.object({ kind: z.literal("multi"), calendars: z.array(cron).min(1).max(MISSION_CALENDAR_LIMIT) }).strict()
    .transform(value => ({ ...value, calendars: [...new Map(value.calendars.map(item =>
      [canonicalAuthority(item), item])).values()].sort((a, b) => canonicalAuthority(a) < canonicalAuthority(b) ? -1 : 1) })),
])

const relativePath = z.string().min(1).max(4096).refine(value => !value.includes("\\") && !value.includes(":")
  && !/[\x00-\x1f\x7f]/.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== ".."), "Explicit relative file path required")
export const missionConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule-success"), missionID: documentID }).strict(),
  z.object({ kind: z.literal("mission-completed"), missionID: documentID }).strict(),
  z.object({ kind: z.literal("branch-commits"), directory: z.string().min(1).max(4096),
    ref: z.string().min(12).max(1024).regex(/^refs\/heads\//).refine(value => !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value)
      && !value.includes("..") && !value.includes("@{") && value.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"))) }).strict(),
  z.object({ kind: z.literal("conversation-message"), conversationID: nativeDocumentID }).strict(),
  z.object({ kind: z.literal("files-changed"), paths: z.array(relativePath).min(1).max(128)
    .refine(paths => new Set(paths).size === paths.length) }).strict(),
])
export const missionLaunchPolicySchema = z.object({ timing: missionTimingSchema, condition: missionConditionSchema.nullable(),
  ends: z.object({ maxLaunches: documentCounter.positive().nullable(), afterMs: duration.nullable(), at: documentTimestamp.nullable() }).strict(),
}).strict()
export type MissionLaunchPolicy = z.infer<typeof missionLaunchPolicySchema>

/** Exact stored configuration; source ownership and native catalog are checked by
 * admission against the selected Location. Creation itself performs no native effects. */
export const missionConfigurationSchema = z.object({
  title: z.string().trim().min(1).max(MISSION_TITLE_MAX).regex(MISSION_TITLE_PATTERN),
  objective: z.string().min(1).max(20_000), notes: z.string().max(20_000).optional(),
  template: z.enum(["custom", "debug", "wayfinder", "delivery", "compare"]),
  profiles: missionProfilesInputSchema, taskMode: missionTaskModeInputSchema,
  profileID: nativeDocumentID.nullable(), executionHost: nativeDocumentID.nullable(),
  roots: z.array(authorityRootSchema).min(1).max(32).refine(roots => new Set(roots.map(item => item.directory)).size === roots.length),
  watchedConversationIDs: z.array(nativeDocumentID).max(64).refine(ids => new Set(ids).size === ids.length),
  launch: missionLaunchPolicySchema,
}).strict().refine(config => {
  try {
    canonicalAuthority(config, MISSION_CONFIGURATION_MAX_BYTES)
    validateMissionProfiles(config.template, config.profiles)
    if (config.template === "compare" && compareModelError(config.profiles)) return false
    if (!requiresMissionCalendar(config.launch)) return true
    const profiles = config.profiles
    return !!config.profileID && !!config.executionHost && !!profiles?.coordinator && missionProfileRoles[config.template].every(role => !!profiles.roles?.[role])
      && [profiles.coordinator, ...Object.values(profiles.roles ?? {})].every(selection =>
        !!selection.agent && !!selection.model?.providerID && !!selection.model.id)
  } catch { return false }
}, "Invalid or over-capacity Mission configuration")
export type MissionConfiguration = z.infer<typeof missionConfigurationSchema>

export function requiresMissionCalendar(policy: MissionLaunchPolicy): boolean {
  return policy.timing.kind !== "immediate" || policy.condition !== null
}
export function missionLaunchLimit(policy: MissionLaunchPolicy): number | null {
  return ["every", "cron", "multi"].includes(policy.timing.kind) ? policy.ends.maxLaunches : 1
}
export function missionSlotEndsAt(policy: MissionLaunchPolicy, firstPlayedAt: number): number | null {
  const values = [policy.ends.at, policy.ends.afterMs === null ? null : documentTimestamp.parse(firstPlayedAt + policy.ends.afterMs)]
    .filter((value): value is number => value !== null)
  return values.length ? Math.min(...values) : null
}
