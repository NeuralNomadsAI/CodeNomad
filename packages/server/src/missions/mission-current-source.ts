import { z } from "zod"

/** Display identity only; the native reader revalidates its owning document. */
export const missionCurrentSourceSchema = z.object({
  owner: z.literal("scheduled"), projectID: z.string().min(1).max(240), scheduleID: z.string().min(3).max(100),
  passageID: z.string().min(3).max(100), missionID: z.string().min(3).max(100), digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  configurationGeneration: z.number().int().positive().safe().optional(), timeGeneration: z.number().int().positive().safe().optional(),
}).strict()
export type MissionCurrentSource = z.infer<typeof missionCurrentSourceSchema>
const id = { type: "string", minLength: 3, maxLength: 100 } as const
export const missionCurrentSourceWire = { type: "object", properties: {
  owner: { type: "string", const: "scheduled" }, projectID: { type: "string", minLength: 1, maxLength: 240 },
  scheduleID: id, passageID: id, missionID: id, digest: { type: "string", minLength: 43, maxLength: 43 },
  configurationGeneration: { type: "integer", minimum: 1 }, timeGeneration: { type: "integer", minimum: 1 },
}, required: ["owner", "projectID", "scheduleID", "passageID", "missionID", "digest"], additionalProperties: false } as const
