import { z } from "zod"

// OpenCode's native `/automation` API (`/api/experimental/automation`):
// `list({ sessionID })` answers the Session's automations, and `pause`, `resume`
// and `delete` act on one automation owned by that Session.
export const AUTOMATION_ID_PATTERN = /^aut_[A-Za-z0-9_-]{1,256}$/
export const automationIdSchema = z.string().regex(AUTOMATION_ID_PATTERN)

const MAX_NAME_CHARS = 1024
const MAX_TEXT_CHARS = 64 * 1024
const MAX_TZ_CHARS = 128

const trimText = (value: string, limit = MAX_TEXT_CHARS): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value

const epochMillisSchema = z.union([z.number().finite(), z.string().min(1)]).transform((value, ctx): number => {
  if (typeof value === "number") return value
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid timestamp" })
    return z.NEVER
  }
  return parsed
})

export const automationTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("at"), at: z.string().max(256), tz: z.string().max(MAX_TZ_CHARS).optional() }),
  z.object({ type: z.literal("every"), every: z.string().max(256), tz: z.string().max(MAX_TZ_CHARS).optional() }),
  z.object({ type: z.literal("cron"), cron: z.string().max(256), tz: z.string().max(MAX_TZ_CHARS).optional() }),
  z.object({ type: z.literal("event"), server: z.string().max(256), event: z.string().max(256) }),
])
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>

export const automationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("prompt"),
    prompt: z.string().max(MAX_TEXT_CHARS + 1),
    target: z.object({ session: z.string().max(512).optional(), subagent: z.string().max(256).optional() }).optional(),
  }),
  z.object({ type: z.literal("code"), code: z.string().max(MAX_TEXT_CHARS + 1) }),
  z.object({ type: z.literal("shell"), command: z.string().max(MAX_TEXT_CHARS + 1) }),
])
export type AutomationAction = z.infer<typeof automationActionSchema>

export const automationStatusSchema = z.enum(["active", "paused", "done"])
export type AutomationStatus = z.infer<typeof automationStatusSchema>

export const automationOutcomeSchema = z.enum(["fired", "late", "skipped", "disabled", "failed", "expired"])
export type AutomationOutcome = z.infer<typeof automationOutcomeSchema>

export const sessionAutomationSchema = z.object({
  id: automationIdSchema,
  name: z.string().max(MAX_NAME_CHARS + 1),
  status: automationStatusSchema,
  trigger: automationTriggerSchema,
  tz: z.string().max(MAX_TZ_CHARS),
  action: automationActionSchema,
  runCount: z.number().int().nonnegative(),
  nextDueAt: z.number().finite().optional(),
  lastRunAt: z.number().finite().optional(),
  lastOutcome: automationOutcomeSchema.optional(),
  lastOutput: z.string().max(MAX_TEXT_CHARS + 1).optional(),
  expires: z.number().finite().optional(),
  stateJson: z.string().max(MAX_TEXT_CHARS + 1).optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
})
export type SessionAutomation = z.infer<typeof sessionAutomationSchema>

export type SessionAutomationAction = "pause" | "resume" | "delete"

/** `GET /api/workspaces/:id/sessions/:sessionId/automations`: `unsupported` without the API, `unavailable` on any other failure. */
export type SessionAutomationsResponse =
  | { status: "ok"; automations: SessionAutomation[] }
  | { status: "unsupported" }
  | { status: "unavailable" }

export type SessionAutomationMutationResponse =
  | { status: "ok"; automation?: SessionAutomation }
  | { status: "error"; error: string; upstream?: true }

const rawTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("at"), at: z.string(), tz: z.string().nullish() }),
  z.object({ type: z.literal("every"), every: z.string(), tz: z.string().nullish() }),
  z.object({ type: z.literal("cron"), cron: z.string(), tz: z.string().nullish() }),
  z.object({ type: z.literal("event"), server: z.string(), event: z.string() }),
])

const rawActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("prompt"),
    prompt: z.string(),
    to: z.object({ session: z.string().nullish(), subagent: z.string().nullish() }).nullish(),
  }),
  z.object({ type: z.literal("code"), code: z.string() }),
  z.object({ type: z.literal("shell"), command: z.string() }),
])

const rawAutomationSchema = z.object({
  id: automationIdSchema,
  name: z.string(),
  projectID: z.string().min(1),
  directory: z.string().min(1),
  sessionID: z.string().nullish(),
  status: automationStatusSchema,
  trigger: rawTriggerSchema,
  tz: z.string(),
  action: rawActionSchema,
  runCount: z.number().int().nonnegative(),
  nextDueAt: epochMillisSchema.nullish(),
  lastRunAt: epochMillisSchema.nullish(),
  lastOutcome: automationOutcomeSchema.nullish(),
  lastOutput: z.string().nullish(),
  expires: epochMillisSchema.nullish(),
  state: z.unknown().optional(),
  time: z.object({ created: epochMillisSchema, updated: epochMillisSchema }),
})

function serializeState(state: unknown): string | undefined {
  if (state === undefined || state === null) return undefined
  try {
    const encoded = JSON.stringify(state, null, 2)
    return typeof encoded === "string" ? trimText(encoded) : undefined
  } catch {
    return undefined
  }
}

/** Projects a raw OpenCode `Automation.Info` into the bounded display contract, dropping internal/unknown fields. */
export function projectSessionAutomation(raw: unknown): {
  automation: SessionAutomation
  sessionID?: string
  projectID: string
  directory: string
} | null {
  const parsed = rawAutomationSchema.safeParse(raw)
  if (!parsed.success) return null
  const item = parsed.data
  const trigger: AutomationTrigger = item.trigger.type === "event"
    ? { type: "event", server: trimText(item.trigger.server, 256), event: trimText(item.trigger.event, 256) }
    : item.trigger.type === "at"
      ? { type: "at", at: trimText(item.trigger.at, 256), ...(item.trigger.tz ? { tz: trimText(item.trigger.tz, MAX_TZ_CHARS) } : {}) }
      : item.trigger.type === "every"
        ? { type: "every", every: trimText(item.trigger.every, 256), ...(item.trigger.tz ? { tz: trimText(item.trigger.tz, MAX_TZ_CHARS) } : {}) }
        : { type: "cron", cron: trimText(item.trigger.cron, 256), ...(item.trigger.tz ? { tz: trimText(item.trigger.tz, MAX_TZ_CHARS) } : {}) }
  const action: AutomationAction = item.action.type === "prompt"
    ? {
        type: "prompt",
        prompt: trimText(item.action.prompt),
        ...(item.action.to && (typeof item.action.to.session === "string" || typeof item.action.to.subagent === "string")
          ? {
              target: {
                ...(typeof item.action.to.session === "string" ? { session: trimText(item.action.to.session, 512) } : {}),
                ...(typeof item.action.to.subagent === "string" ? { subagent: trimText(item.action.to.subagent, 256) } : {}),
              },
            }
          : {}),
      }
    : item.action.type === "code"
      ? { type: "code", code: trimText(item.action.code) }
      : { type: "shell", command: trimText(item.action.command) }

  const automation: SessionAutomation = {
    id: item.id,
    name: trimText(item.name, MAX_NAME_CHARS),
    status: item.status,
    trigger,
    tz: trimText(item.tz, MAX_TZ_CHARS),
    action,
    runCount: item.runCount,
    ...(item.nextDueAt != null ? { nextDueAt: item.nextDueAt } : {}),
    ...(item.lastRunAt != null ? { lastRunAt: item.lastRunAt } : {}),
    ...(item.lastOutcome != null ? { lastOutcome: item.lastOutcome } : {}),
    ...(item.lastOutput != null ? { lastOutput: trimText(item.lastOutput) } : {}),
    ...(item.expires != null ? { expires: item.expires } : {}),
    ...(item.state !== undefined && item.state !== null ? { stateJson: serializeState(item.state) } : {}),
    createdAt: item.time.created,
    updatedAt: item.time.updated,
  }
  return { automation, sessionID: item.sessionID ?? undefined, projectID: item.projectID, directory: item.directory }
}
