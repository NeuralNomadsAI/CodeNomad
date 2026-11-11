import { z } from "zod"
import { MAX_CONTROL_FAMILY_SESSIONS } from "./native-session-family"

/** Native family at explicit adoption: id, last seq, last message, inherited
 * in-flight input, durable native aggregate sequence. */
export const coordinatorBaselineSchema = z.array(z.tuple([z.string().min(1).max(240), z.number().int().min(-1).safe(),
  z.string().min(1).max(240).nullable(), z.string().min(1).max(240).nullable(), z.number().int().nonnegative().safe()])
  .refine(row => (row[1] === -1) === (row[2] === null)))
  .max(MAX_CONTROL_FAMILY_SESSIONS).refine(rows => new Set(rows.map(row => row[0])).size === rows.length)
export type CoordinatorBaseline = z.infer<typeof coordinatorBaselineSchema>
export const COORDINATOR_INPUT_MARKER = "codenomad.passage-input"
export const coordinatorInputSchema = z.object({ passageID: z.string().min(1).max(240), missionID: z.string().min(1).max(240),
  coordinatorSessionID: z.string().min(1).max(240), messageID: z.string().min(1).max(240) }).strict()
export type CoordinatorInputOwner = Omit<z.infer<typeof coordinatorInputSchema>, "messageID">
