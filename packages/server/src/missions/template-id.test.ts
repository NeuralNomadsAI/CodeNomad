import assert from "node:assert/strict"
import test from "node:test"
import { parseMissionEvent } from "./journal"
import { recurrenceConfigSchema } from "./recurrence-contract"
import { LEGACY_DEBUG_TEMPLATE_ID } from "./template-id"
import { missionProfileRoles } from "./playbook-profiles"
import { MISSION_SCHEMA_VERSION } from "./model"

const created = (template: string) => ({
  version: MISSION_SCHEMA_VERSION, type: "mission.created", id: "evt_created", missionID: "msn_stored", projectID: "project",
  createdAt: 1, projectCanonical: "/repo", objective: "Fix it", template,
  coordinator: { sessionID: "ses_coordinator", title: "Coordinator", location: { directory: "/repo" } },
})

test("stored missions created with the legacy Debugging template ID decode as debug", () => {
  const template = (value: string) => {
    const event = parseMissionEvent(created(value))
    return event?.type === "mission.created" ? event.template : undefined
  }
  assert.equal(template(LEGACY_DEBUG_TEMPLATE_ID), "debug")
  assert.equal(template("debug"), "debug")
  assert.equal(parseMissionEvent(created("unknown")), undefined)
})

test("stored recurrence schedules with the legacy Debugging template ID decode as debug", () => {
  const execution = { agent: "worker", model: { providerID: "provider", id: "model" } }
  const config = { title: "Review", template: LEGACY_DEBUG_TEMPLATE_ID, consigne: "Fix the watched bug.",
    clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
    profiles: { coordinator: execution, roles: Object.fromEntries(missionProfileRoles.debug.map(role => [role, execution])) },
    taskMode: "native", roots: [{ mode: "directory-only", directory: "/owned/project" }], watchedConversationIDs: [] }
  assert.equal(recurrenceConfigSchema.parse(config).template, "debug")
})
