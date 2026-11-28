import { z } from "zod"
import { missionConfigurationSchema, missionCriteriaLaunchPolicySchema } from "./launch-policy"
import { criteriaLaunchPolicyWire } from "./mission-document-wire"
import { missionProfilesSchema } from "./playbook-profiles"
import { missionTaskModeSchema } from "./task-execution-mode"

/** The configuration of a programmed Mission as agents write it, and its wire. */
const { roots: _roots, profileID: _profile, executionHost: _host, coordinatorSelectionAuthor: _author, ...fields } = missionConfigurationSchema.shape
const missionProgramConfiguration = z.object({ ...fields, launch: missionCriteriaLaunchPolicySchema }).strict()
const text = { type: "string" } as const
export const missionProgramConfigurationWire = { type: "object", properties: {
  title: text, objective: text, notes: text, template: { type: "string", enum: ["custom", "debug", "wayfinder", "delivery", "compare"] },
  profiles: missionProfilesSchema, taskMode: missionTaskModeSchema, coordinatorSessionID: text, coordinatorGoal: { type: "boolean" },
  watchedConversationIDs: { type: "array", maxItems: 64, items: text }, launch: criteriaLaunchPolicyWire,
}, required: ["title", "objective", "template", "taskMode", "watchedConversationIDs", "launch"], additionalProperties: false } as const

const actions = ["list", "save", "pause", "resume", "delete"] as const
const ID = /^[A-Za-z0-9_-]{3,100}$/

/** `mission.program`: the programmed Missions of the caller's directory. `save` creates the one `id` names, or replaces it. */
export const missionProgramInput = z.object({ action: z.enum(actions), id: z.string().regex(ID).optional(),
  configuration: missionProgramConfiguration.optional(), paused: z.boolean().optional() }).strict()
  .refine(value => (value.action === "list") === (value.id === undefined) && (value.action === "save") === (value.configuration !== undefined)
    && (value.paused === undefined || value.action === "save"), "Invalid programmed Mission action fields")
export type MissionProgramInput = z.infer<typeof missionProgramInput>
export const missionProgramWire = { type: "object", properties: {
  action: { type: "string", enum: actions }, id: { type: "string", minLength: 3, maxLength: 100 },
  configuration: missionProgramConfigurationWire, paused: { type: "boolean" },
}, required: ["action"], additionalProperties: false } as const
