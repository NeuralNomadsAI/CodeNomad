import { z } from "zod"

export const missionTaskKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/)

/** This reference is a task generation, never a journal/document revision. */
export const taskContractReferenceSchema = z.object({
  missionID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/),
  taskKey: missionTaskKeySchema,
  generation: z.number().int().positive().safe(),
}).strict()
export type TaskContractReference = z.infer<typeof taskContractReferenceSchema>
