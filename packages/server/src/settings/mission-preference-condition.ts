import { z } from "zod"
import { isPlainObject } from "./merge-patch"
import type { SettingsService } from "./service"

const keys = ["missionModels", "missionProfileDefaults"] as const
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

// Validate JSON, not the preference domain: conditions must also permit repairing
// an invalid stored preference by comparing its original, unnormalized value.
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(JsonValueSchema), z.record(JsonValueSchema),
]))

const ExpectedSchema = z.object({
  key: z.enum(keys),
  present: z.boolean(),
  value: JsonValueSchema.optional(),
}).strict().superRefine((expected, ctx) => {
  if (expected.present !== hasOwn(expected, "value")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value is required only when present is true" })
  }
})

const ConditionalSchema = z.object({
  patch: z.object({
    settings: z.object({
      missionModels: JsonValueSchema.optional(),
      missionProfileDefaults: JsonValueSchema.optional(),
    }).strict(),
  }).strict(),
  expected: z.array(ExpectedSchema).min(1).max(2),
}).strict().superRefine((body, ctx) => {
  const changedKeys = Object.keys(body.patch.settings)
  const expectedKeys = new Set(body.expected.map((expected) => expected.key))
  if (expectedKeys.size !== body.expected.length
    || changedKeys.length !== expectedKeys.size
    || changedKeys.some((key) => !expectedKeys.has(key as typeof keys[number]))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected keys must exactly match the distinct patched keys" })
  }
})

function equalJson(a: unknown, b: JsonValue): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => equalJson(value, b[index]))
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const aKeys = Object.keys(a)
  return aKeys.length === Object.keys(b).length
    && aKeys.every((key) => hasOwn(b, key) && equalJson(a[key], b[key]))
}

export class MissionPreferenceConflictError extends Error {
  constructor() {
    super("Mission preferences changed; reload before saving")
  }
}

/** Synchronous compare-and-merge within the owning backend event loop. */
export function applyConditionalMissionPreferences(
  settings: Pick<SettingsService, "getRawConfigOwner" | "mergePatchOwner">,
  owner: string,
  body: unknown,
) {
  if (owner !== "ui") throw new Error("Conditional mission preferences require the ui owner")
  const parsed = ConditionalSchema.parse(body)
  const current = settings.getRawConfigOwner("ui")
  const rawSettings = isPlainObject(current) && isPlainObject(current.settings) ? current.settings : {}
  for (const expected of parsed.expected) {
    if (hasOwn(rawSettings, expected.key) !== expected.present
      || (expected.present && !equalJson(rawSettings[expected.key], expected.value!))) {
      throw new MissionPreferenceConflictError()
    }
  }
  // Do not introduce an await between the authoritative read above and this write.
  return settings.mergePatchOwner("config", "ui", parsed.patch)
}
