import { createHash } from "node:crypto"
import { z } from "zod"
import { missionSettingsInput } from "../../missions/settings-tool"
import { normalizeMissionModels, validMissionModels, parseMissionModel, saveMissionModelRecord, removeMissionModelRecord } from "../../missions/model-library"
import { encodeMissionDefaults, normalizeMissionDefaults, validMissionDefaults } from "../../missions/profile-defaults"
import { applyConditionalMissionPreferences, MissionPreferenceConflictError } from "../../settings/mission-preference-condition"
import { isPlainObject } from "../../settings/merge-patch"
import type { SettingsService } from "../../settings/service"
import type { SubagentDepthSettings } from "../../opencode/subagent-depth-settings"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { ownedMissionAgent } from "./mission-agent-owner"

const commandSchema = z.object({ kind: z.literal("settings"), input: missionSettingsInput }).strict()
type Settings = Pick<SettingsService, "getRawConfigOwner" | "mergePatchOwner">
type Deps = {
  workspaceManager: Parameters<typeof ownedMissionAgent>[0]
  settings?: Partial<Settings>
  subagentDepth?: Pick<SubagentDepthSettings, "read" | "update">
}
// Hash the raw field and its presence, before any domain decoding. Invalid values
// retain their repair guard without putting an arbitrarily large library in a tool reply.
const expectation = (present: boolean, value: unknown) => createHash("sha256")
  .update(JSON.stringify(present ? { present, value } : { present }), "utf16le").digest("hex")

/** The private bridge alone identifies the agent; writes use the UI/native owners. */
export async function controlAgentMissionSettings(deps: Deps, sessionID: string, raw: unknown, signal: AbortSignal) {
  const { input } = commandSchema.parse(raw)
  const agent = await ownedMissionAgent(deps.workspaceManager, sessionID, signal)
  await agent.refresh()
  const principal = { kind: "agent" as const, sessionID }
  if (input.scope === "depth") {
    if (!deps.subagentDepth) throw new PluginControlsError("Mission depth settings unavailable", "unavailable")
    const location = { directory: agent.session.location.directory }
    if (input.action === "read") {
      const snapshot = await deps.subagentDepth.read(agent.workspace.id, location)
      await agent.refresh()
      return { principal, scope: "project-location", snapshot }
    }
    await deps.subagentDepth.update(agent.workspace.id, location, input.depth!, input.expectation!)
    return { principal, saved: true }
  }
  const settings = deps.settings
  if (!settings?.getRawConfigOwner || !settings.mergePatchOwner) throw new PluginControlsError("Mission preferences unavailable", "unavailable")
  const owner = settings.getRawConfigOwner("ui")
  if (owner.settings !== undefined && !isPlainObject(owner.settings)) throw new Error("Invalid UI settings owner")
  const values = isPlainObject(owner.settings) ? owner.settings : {}
  const key = input.scope === "configurations" ? "missionModels" : input.field
  const present = Object.hasOwn(values, key), value = values[key], expected = expectation(present, value)
  const valid = key === "missionModels" ? validMissionModels(value)
    : key === "missionProfileDefaults" ? validMissionDefaults(value) : value === undefined || typeof value === "boolean"
  if (input.action === "read") return { principal, scope: "codenomad-profile", field: key, present, valid, expectation: expected,
    ...(key === "missionModels" ? { configurations: valid ? normalizeMissionModels(value).map(({ id, name, template }) => ({ id, name, template })) : [] }
      : valid ? { value: key === "missionProfileDefaults" ? normalizeMissionDefaults(value) : value ?? false } : {}) }
  if (input.expectation !== expected) throw new MissionPreferenceConflictError()
  let next: unknown
  if (input.action === "reset") next = key === "missionDeleteSessions" ? null : []
  else if (input.scope === "configurations") {
    if (!valid) throw new PluginControlsError("Invalid configuration library; reset it with its original expectation", "invalid")
    const models = normalizeMissionModels(value)
    if (input.action === "delete") next = removeMissionModelRecord(models, input.configurationID!)
    else {
      const model = parseMissionModel({ version: 1, ...input.configuration })
      try { next = saveMissionModelRecord(models, model) }
      catch { throw new PluginControlsError("Mission configuration limit reached", "invalid") }
    }
  } else if (input.field === "missionProfileDefaults") {
    if (!validMissionDefaults(input.defaults)) throw new Error("Invalid mission profile defaults")
    next = encodeMissionDefaults(input.defaults!.map(entry => ({ ...entry, profiles: entry.profiles! })))
  } else next = input.deleteSessions
  // Synchronous raw compare/write after the final caller check; the conditional
  // owner rechecks the authoritative disk document inside its ordinary write.
  agent.current()
  applyConditionalMissionPreferences(settings as Settings, "ui", {
    patch: { settings: { [key]: next } }, expected: [{ key, present, ...(present ? { value } : {}) }],
  })
  return { principal, saved: true, ...(input.scope === "configurations" && input.configuration ? { configurationID: input.configuration.id } : {}) }
}
