import { z } from "zod"
import { MissionControlError } from "../../missions/control-error"
import { parseMissionCreationDefaultsInput } from "../../missions/creation-defaults"
import { MissionPreferencesError, resolveMissionCreationDefaults } from "../../missions/profile-defaults"
import { MISSION_DEFAULTS_REQUEST_INVALID, missionRecoveryControlError as refusal } from "../../missions/recovery-error"
import { isPlainObject } from "../../settings/merge-patch"
import type { SettingsService } from "../../settings/service"

const commandSchema = z.object({ kind: z.literal("profile-defaults"), input: z.unknown() }).strict()

/** Read the UI owner's raw document afresh for each creation; never persist resolved choices. */
export function readMissionProfileDefaults(settings: Partial<Pick<SettingsService, "getRawConfigOwner">> | undefined, command: unknown) {
  const parsed = commandSchema.safeParse(command)
  if (!parsed.success) throw new MissionControlError(MISSION_DEFAULTS_REQUEST_INVALID, "invalid-execution")
  const input = parseMissionCreationDefaultsInput(parsed.data.input)
  let preferences: unknown
  try {
    if (!settings?.getRawConfigOwner) throw new Error("Missing preference reader")
    const owner = settings.getRawConfigOwner("ui")
    if (owner.settings !== undefined && !isPlainObject(owner.settings)) throw new Error("Invalid settings owner")
    preferences = isPlainObject(owner.settings) ? owner.settings.missionProfileDefaults : undefined
  } catch { throw refusal("mission-preferences-unavailable") }
  try { return resolveMissionCreationDefaults({ ...input, preferences }) }
  catch (error) {
    if (error instanceof MissionPreferencesError) throw refusal("mission-preferences-invalid")
    throw error
  }
}
