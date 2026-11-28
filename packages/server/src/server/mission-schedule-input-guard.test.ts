import assert from "node:assert/strict"
import { test } from "node:test"
import { MISSION_GOAL_CARRIER_SESSION_PREFIX, MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../missions/mission-schedule-carrier-identity"
import { assertOrdinaryMissionScheduleBody, assertOrdinaryMissionScheduleSession, MissionScheduleInputError } from "./mission-schedule-input-guard"

const denied = (statusCode: number) => (error: unknown) => error instanceof MissionScheduleInputError && error.statusCode === statusCode

test("a carrier is refused by its reserved ID, marker, model or title; any other conversation is ordinary", () => {
  assertOrdinaryMissionScheduleSession({ id: "ses_ordinary", metadata: { trace: "kept" }, model: { providerID: "anthropic", id: "opus" }, title: "Work" })
  for (const session of [
    { id: `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}calendar_abc` }, { id: `${MISSION_GOAL_CARRIER_SESSION_PREFIX}abc` },
    { id: "ses_marked", metadata: { "codenomad.schedule-carrier": { version: 1 } } },
    { id: "ses_model", model: { providerID: "codenomad-missions-local", id: "schedule-noop" } },
    { id: "ses_title", title: "Mission schedule carrier" },
  ]) assert.throws(() => assertOrdinaryMissionScheduleSession(session), denied(403), session.id)
})

test("ordinary metadata is preserved, while reserved metadata is refused throughout imported sources", () => {
  const ordinary = { text: "metadata.schedule is just text", metadata: { trace: "kept" } }
  const before = structuredClone(ordinary)
  assertOrdinaryMissionScheduleBody(ordinary)
  assert.deepEqual(ordinary, before)
  for (const metadata of [{ schedule: {} }, { schedule: null }, { "codenomad.schedule-carrier": {} }]) {
    assert.throws(() => assertOrdinaryMissionScheduleBody({ metadata }), denied(403))
    for (const body of [{ info: { metadata } }, { messages: [{ metadata }] },
      { messages: [{ type: "user", source: { messages: [{ source: { metadata } }] } }] }]) {
      assert.throws(() => assertOrdinaryMissionScheduleBody(body, true), denied(403))
    }
  }
  for (const body of [null, "opaque", Buffer.from("{}"), []]) assert.throws(() => assertOrdinaryMissionScheduleBody(body), denied(400))
  assertOrdinaryMissionScheduleBody(undefined)
})
