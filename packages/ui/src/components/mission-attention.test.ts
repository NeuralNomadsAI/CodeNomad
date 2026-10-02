import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  MISSION_ATTENTION_UNCORRELATABLE_SESSION,
  selectMissionAttention,
  type MissionAttentionSource,
  type MissionAttentionTask,
} from "./mission-attention-model.ts"

const actor = (sessionId: string, title = sessionId) => ({ sessionId, title })

const form = (id: string, sessionID: string, fields = 2) => ({
  id,
  sessionID,
  title: `Request ${id}`,
  fields: Array.from({ length: fields }, (_, index) => ({ key: `f${index}` })),
})

/** The selector only reads a task's identity and, when present, its report. */
const task = (id: string, outcome?: "blocked" | "completed", summary = `Reported ${outcome}.`): MissionAttentionTask => ({
  id,
  key: "mission-ux",
  title: "Choose the journey",
  ...(outcome ? { report: { outcome, summary } } : {}),
})

const source = (overrides: Partial<MissionAttentionSource> = {}): MissionAttentionSource => ({
  actors: [actor("ses-active"), actor("ses-background", "Background scout")],
  forms: [],
  permissions: [],
  tasks: [],
  ...overrides,
})

describe("selectMissionAttention", () => {
  it("reconciles open native requests for a background actor that is not the active session", () => {
    const items = selectMissionAttention(source({ forms: [form("form-1", "ses-background", 3)] }))

    assert.equal(items.length, 1)
    assert.equal(items[0].kind, "form")
    assert.equal(items[0].sessionId, "ses-background")
    assert.equal(items[0].questions, 3)
    assert.equal(items[0].open, true)
  })

  it("drops the item once the native request leaves the queue", () => {
    assert.equal(selectMissionAttention(source({ forms: [form("form-1", "ses-background")] })).length, 1)

    const afterRemoval = source({ permissions: [] })
    assert.deepEqual(selectMissionAttention(afterRemoval), [])
  })

  it("keeps permissions and forms separate so a permission is never read as a question", () => {
    const items = selectMissionAttention(source({
      forms: [form("form-1", "ses-background")],
      permissions: [{ id: "perm-1", sessionID: "ses-background", action: "bash", resources: ["rm -rf build"] }],
    }))

    assert.deepEqual(items.map(item => item.kind), ["form", "permission"])
    assert.deepEqual(items[1].resources, ["rm -rf build"])
  })

  it("ignores requests that cannot be attributed to an actor", () => {
    const items = selectMissionAttention(source({
      forms: [form("form-global", MISSION_ATTENTION_UNCORRELATABLE_SESSION), form("form-foreign", "ses-elsewhere")],
      permissions: [{ id: "perm-1", sessionID: MISSION_ATTENTION_UNCORRELATABLE_SESSION, action: "bash" }],
    }))

    assert.deepEqual(items, [])
  })

  it("reports a blockage as history rather than as a live wait", () => {
    // A `blocked` report is what produces the historical `needs-input` task
    // status, so the actor has already returned: it must not read as a live wait.
    const items = selectMissionAttention(source({
      tasks: [task("task-1", "blocked", "Waiting on a coordinator decision.")],
    }))

    assert.equal(items.length, 1)
    assert.equal(items[0].kind, "blocked")
    assert.equal(items[0].open, false)
    assert.equal(items[0].sessionId, undefined)
    assert.equal(items[0].taskKey, "mission-ux")
    assert.equal(items[0].summary, "Waiting on a coordinator decision.")
  })

  it("does not treat a task without a blocked report as attention", () => {
    assert.deepEqual(selectMissionAttention(source({ tasks: [task("task-1")] })), [])
    assert.deepEqual(selectMissionAttention(source({ tasks: [task("task-1", "completed")] })), [])
  })

  it("lists live requests before reported blockages", () => {
    const items = selectMissionAttention(source({
      forms: [form("form-1", "ses-background")],
      tasks: [task("task-1", "blocked")],
    }))

    assert.deepEqual(items.map(item => item.open), [true, false])
  })
})
