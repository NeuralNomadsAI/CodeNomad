import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  MISSION_ATTENTION_UNCORRELATABLE_SESSION,
  selectMissionAttention,
  selectMissionFamilyMembers,
  missionIncludesSession,
  type MissionObservedFamily,
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

const family: MissionObservedFamily = { state: "observed", members: [
  { sessionId: "ses-active", actorSessionId: "ses-active", kind: "declared" },
  { sessionId: "ses-background", parentSessionId: "ses-active", actorSessionId: "ses-background", kind: "declared" },
  { sessionId: "child", parentSessionId: "ses-background", actorSessionId: "ses-background", taskKey: "context-only", kind: "ordinary" },
  { sessionId: "grandchild", parentSessionId: "child", actorSessionId: "ses-background", kind: "ordinary" },
] }

it("correlates a descendant Form and permission to its nearest declared actor without changing the answer target", () => {
  const items = selectMissionAttention(source({ family, forms: [form("child-question", "grandchild")],
    permissions: [{ id: "child-permission", sessionID: "child", action: "read" }] }))
  assert.deepEqual(items.map(item => [item.sessionId, item.actorSessionId, item.taskKey]), [
    ["grandchild", "ses-background", undefined], ["child", "ses-background", undefined],
  ])
  assert(items.every(item => item.open))
})

it("unknown or missing family uses only exact declared actors, even if stale members remain", () => {
  for (const observed of [undefined, { ...family, state: "unknown" as const }]) {
    const input = source({ family: observed, forms: [form("child", "child"), form("actor", "ses-active")] })
    assert.deepEqual(selectMissionAttention(input).map(item => item.sessionId), ["ses-active"])
    assert.equal(missionIncludesSession(input.actors, "child", observed), false)
    assert.equal(missionIncludesSession(input.actors, "ses-active", observed), true)
  }
})

it("ordinary membership never admits unrelated/global sessions or relabels declared actors", () => {
  const input = source({ family, forms: [form("global", "global"), form("unrelated", "elsewhere")] })
  assert.deepEqual(selectMissionAttention(input), [])
  assert.deepEqual(selectMissionFamilyMembers(input.actors, family).map(member => member.sessionId), ["child", "grandchild"])
  assert.equal(missionIncludesSession(input.actors, "grandchild", family), true)
  assert.equal(missionIncludesSession(input.actors, "elsewhere", family), false)
})

it("rejects ambiguous, cyclic, incomplete and wrong-nearest-actor ancestry", () => {
  const actors = source().actors
  const child = family.members[2]
  assert.deepEqual(selectMissionFamilyMembers(actors, { ...family, members: [...family.members, child] }), [])
  for (const parentSessionId of ["child", "missing"]) assert.deepEqual(selectMissionFamilyMembers(actors,
    { ...family, members: [{ ...child, parentSessionId }] }), [])
  assert.deepEqual(selectMissionFamilyMembers(actors, { ...family, members: [{ ...child, actorSessionId: "ses-active" }] }), [])
  assert.deepEqual(selectMissionFamilyMembers(actors, { ...family, members: Array.from({ length: 265 }, (_, n) => ({ ...child, sessionId: `child-${n}` })) }), [])
})

it("all ten Mission locales own family labels without English fallback", async () => {
  const keys = ["declared", "ordinary", "ancestry", "unknown"].map(name => `missions.control.family.${name}`)
  const en = (await import("../lib/i18n/messages/en/missions.ts")).missionMessages as Record<string, string>
  for (const locale of ["en", "de", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const bundle = (await import(`../lib/i18n/messages/${locale}/missions.ts`)).missionMessages as Record<string, string>
    for (const key of keys) {
      assert(Object.prototype.hasOwnProperty.call(bundle, key), `${locale} owns ${key}`)
      assert(bundle[key].trim(), `${locale} translates ${key}`)
      if (locale !== "en") assert.notEqual(bundle[key], en[key], `${locale} does not fall back for ${key}`)
    }
    assert.match(bundle[keys[2]], /\{parent\}/); assert.match(bundle[keys[2]], /\{actor\}/)
  }
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
