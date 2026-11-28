import { z } from "zod"
import { scheduleToolConfiguration, scheduleToolWire } from "./schedule-tool"

const actions = ["list", "save", "pause", "resume", "delete"] as const
const ID = /^[A-Za-z0-9_-]{3,100}$/

/** `mission.program`: the programmed Missions of the caller's directory. `save` creates the one `id` names, or replaces it. */
export const missionProgramInput = z.object({ action: z.enum(actions), id: z.string().regex(ID).optional(),
  configuration: scheduleToolConfiguration.optional(), paused: z.boolean().optional() }).strict()
  .refine(value => (value.action === "list") === (value.id === undefined) && (value.action === "save") === (value.configuration !== undefined)
    && (value.paused === undefined || value.action === "save"), "Invalid programmed Mission action fields")
export type MissionProgramInput = z.infer<typeof missionProgramInput>
export const missionProgramWire = { type: "object", properties: {
  action: { type: "string", enum: actions }, id: { type: "string", minLength: 3, maxLength: 100 },
  configuration: scheduleToolWire.properties.configuration, paused: { type: "boolean" },
}, required: ["action"], additionalProperties: false } as const
