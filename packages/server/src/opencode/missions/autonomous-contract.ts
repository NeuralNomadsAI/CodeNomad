import { z } from "zod"

const id = z.string().min(1).max(100)
const input = z.object({
  sessionID: z.string().regex(/^ses/).max(240), id: z.string().regex(/^msg_/).max(240),
  text: z.string().min(1).max(250_000), description: z.string().max(240).optional(),
  metadata: z.object({ "codenomad.mission": z.object({
    version: z.literal(1), missionID: id, kind: z.enum(["assignment", "report", "recovery"]),
    taskKey: id.optional(), role: id.optional(), reportID: id.optional(),
    fromSessionID: z.string().max(240).optional(), target: z.enum(["coordinator", "report"]).optional(),
    revision: z.number().int().positive().optional(),
  }).strict() }).strict(), delivery: z.enum(["queue", "steer"]), resume: z.literal(true),
}).strict()
const commandSchema = z.object({ kind: z.enum(["prompt", "synthetic"]), input }).strict()
export type AutonomousMissionCommand = z.infer<typeof commandSchema>
