import { z } from "zod"
import { recurrenceIDSchema } from "./recurrence-contract"

export const recurrenceListInput = z.object({ after: recurrenceIDSchema.optional(), limit: z.number().int().min(1).max(8).default(8) }).strict()
export const recurrencePlacementSchema = z.object({ id: recurrenceIDSchema, directory: z.string().min(1).max(4096) }).strict()
export const recurrenceListSchema = z.object({
  projectID: z.string().min(1), projectCanonical: z.string().min(1),
  schedules: z.array(recurrencePlacementSchema).max(8), next: recurrenceIDSchema.optional(),
}).strict()
export const recurrencePlacementReadSchema = z.object({
  schedule: recurrencePlacementSchema.extend({ revision: z.number().int().nonnegative(), state: z.enum(["paused", "running", "stopped"]),
    digest: z.string(), projectID: z.string(), projectCanonical: z.string() }).nullable(),
}).strict()

export const recurrenceListWire = {
  input: { type: "object", properties: { after: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 8 } }, additionalProperties: false },
  output: { type: "object", properties: {
    projectID: { type: "string" }, projectCanonical: { type: "string" },
    schedules: { type: "array", maxItems: 8, items: { type: "object", properties: { id: { type: "string" }, directory: { type: "string", maxLength: 4096 } },
      required: ["id", "directory"], additionalProperties: false } }, next: { type: "string" },
  }, required: ["projectID", "projectCanonical", "schedules"], additionalProperties: false },
} as const
