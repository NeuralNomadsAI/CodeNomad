import { z } from "zod"
import { MissionControlError } from "../../missions/control-error"
import { missionProfilesInputSchema, validateMissionProfiles } from "../../missions/playbook-profiles"
import { resolveMissionCreationDefaults } from "../../missions/profile-defaults"
import { missionRecoveryError } from "../../missions/recovery-error"
import { missionTaskModeInputSchema } from "../../missions/task-execution-mode"
import { isPlainObject } from "../../settings/merge-patch"
import type { SettingsService } from "../../settings/service"
import { parseExecution } from "../../missions/execution"

const commandSchema = z.object({ kind: z.literal("profile-defaults"), input: z.object({
  template: z.enum(["custom", "wayfinder", "debug", "delivery", "compare"]),
  profiles: missionProfilesInputSchema,
  taskMode: missionTaskModeInputSchema.optional(),
  coordinatorModel: z.unknown().transform((model, context) => {
    try { return parseExecution({ model })?.model }
    catch { context.addIssue({ code: "custom", message: "Invalid coordinator model" }); return z.NEVER }
  }).optional(),
}).strict() }).strict()

function refusal(code: "mission-preferences-invalid" | "mission-preferences-unavailable"): MissionControlError {
  const error = missionRecoveryError(code)!
  return new MissionControlError(error.message, error.code)
}

/** Read the UI owner's raw document afresh for each creation; never persist resolved choices. */
export function readMissionProfileDefaults(settings: Partial<Pick<SettingsService, "getRawConfigOwner">> | undefined, command: unknown) {
  const parsed = commandSchema.safeParse(command)
  if (!parsed.success) throw refusal("mission-preferences-invalid")
  const { input } = parsed.data
  try { validateMissionProfiles(input.template, input.profiles) }
  catch { throw refusal("mission-preferences-invalid") }
  let preferences: unknown
  try {
    if (!settings?.getRawConfigOwner) throw new Error("Missing preference reader")
    const owner = settings.getRawConfigOwner("ui")
    if (owner.settings !== undefined && !isPlainObject(owner.settings)) throw new Error("Invalid settings owner")
    preferences = isPlainObject(owner.settings) ? owner.settings.missionProfileDefaults : undefined
  } catch { throw refusal("mission-preferences-unavailable") }
  try { return resolveMissionCreationDefaults({ ...input, preferences }) }
  catch { throw refusal("mission-preferences-invalid") }
}
