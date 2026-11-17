import { z } from "zod"
import { dailyClockSchema } from "./recurrence-clock"
import { missionProfilesInputSchema } from "./playbook-profiles"
import { missionTaskModeInputSchema } from "./task-execution-mode"
import { MISSION_TITLE_MAX, MISSION_TITLE_PATTERN } from "./mission-title"
import { MISSION_LIFECYCLE_TEXT_LIMIT } from "./lifecycle-input"

/** Paused daily creation, shared by HTTP admission and the model-facing tool. */
export const recurrenceCreateSchema = z.object({ requestID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/),
  instructions: z.string().trim().min(1).max(MISSION_LIFECYCLE_TEXT_LIMIT), clock: dailyClockSchema,
  title: z.string().trim().min(1).max(MISSION_TITLE_MAX).regex(MISSION_TITLE_PATTERN).optional(),
  notes: z.string().max(20_000).optional(),
  template: z.enum(["custom", "debug", "wayfinder", "delivery", "compare"]),
  directory: z.string().min(1).max(4096).optional(),
  watchedConversationIDs: z.array(z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/)).max(32)
    .refine(ids => new Set(ids).size === ids.length),
  profiles: missionProfilesInputSchema,
  taskMode: missionTaskModeInputSchema,
}).strict()
