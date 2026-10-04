import assert from "node:assert/strict"
import { test } from "node:test"
import type { MissionActor } from "../../../server/src/api-types"
import type { MissionObservedFamily } from "./mission-attention-model"
import { missionConversationTree, missionConversationRuntimeState, type MissionConversationNode } from "./mission-conversation-tree.ts"

const actor = (sessionId: string, kind: MissionActor["kind"] = "specialist"): MissionActor => ({
  sessionId, kind, title: sessionId, managed: false, roles: [kind], joinedAt: 1, location: { directory: "/fixture" },
})
const actors = [actor("independent"), actor("native"), actor("coordinator", "coordinator")]
const declared = (sessionId: string, parentSessionId?: string): MissionObservedFamily["members"][number] => ({ sessionId, parentSessionId, actorSessionId: sessionId, kind: "declared" })
const ordinary = (sessionId: string, parentSessionId: string, actorSessionId = "native"): MissionObservedFamily["members"][number] => ({ sessionId, parentSessionId, actorSessionId, kind: "ordinary" })
const family: MissionObservedFamily = { state: "observed", members: [
  declared("coordinator"), declared("native", "coordinator"), declared("independent"),
  ordinary("one", "native"), ordinary("two", "one"), ordinary("three", "two"),
  ordinary("four", "three"), ordinary("five", "four"), ordinary("sibling", "native"),
] }
const flatten = (roots: MissionConversationNode[]): string[] => roots.flatMap(node => [node.sessionId, ...flatten(node.children)])

test("native children and five recursive levels remain nested, with children before siblings in shuffled input", () => {
  for (const members of [family.members, [...family.members].reverse(), [...family.members.slice(5), ...family.members.slice(0, 5)]]) {
    const tree = missionConversationTree(actors, { ...family, members })
    assert.equal(tree.known, true); assert.equal(tree.count, 9)
    assert.deepEqual(flatten(tree.roots), ["coordinator", "native", "one", "two", "three", "four", "five", "sibling", "independent"])
    assert.deepEqual(tree.roots.map(node => node.sessionId), ["coordinator", "independent"])
    let node = tree.roots[0].children[0]
    for (const id of ["one", "two", "three", "four", "five"]) { node = node.children[0]; assert.equal(node.sessionId, id) }
    assert.equal(node.parentSessionId, "four")
  }
})

test("missing, stale and unknown observations preserve distinct declarations only, never local ancestry", () => {
  for (const observation of [undefined, { ...family, state: "unknown" as const }]) {
    const tree = missionConversationTree([...actors, actors[0]], observation)
    assert.equal(tree.known, false); assert.equal(tree.count, 3)
    assert.deepEqual(flatten(tree.roots), ["coordinator", "independent", "native"])
    assert(tree.roots.every(node => !node.parentSessionId))
  }
})

test("a declared root's external native parent is a boundary, not a missing Mission ancestor", () => {
  const input = [actor("coordinator", "coordinator"), actor("native")]
  const observed: MissionObservedFamily = { state: "observed", members: [
    ordinary("child", "native"), declared("native", "coordinator"), declared("coordinator", "outside-mission"),
  ] }
  const before = structuredClone(observed)
  const tree = missionConversationTree(input, observed)
  assert.equal(tree.known, true); assert.equal(tree.count, 3)
  assert.deepEqual(flatten(tree.roots), ["coordinator", "native", "child"])
  assert.equal(tree.roots.length, 1); assert.equal(tree.roots[0].parentSessionId, undefined)
  assert.equal(tree.roots[0].children[0].parentSessionId, "coordinator")
  assert.equal(tree.roots[0].children[0].children[0].parentSessionId, "native")
  assert(!JSON.stringify(tree).includes("outside-mission"), "external ancestry is not displayed or invented")
  assert.deepEqual(observed, before, "the authoritative native parent metadata is unchanged")
})

test("independent declared roots retain their own boundaries even when they share an external native parent", () => {
  const tree = missionConversationTree(actors, { state: "observed", members: [
    declared("independent", "outside-mission"), ordinary("child", "native"),
    declared("native", "coordinator"), declared("coordinator", "outside-mission"),
  ] })
  assert.equal(tree.known, true); assert.equal(tree.count, 4)
  assert.deepEqual(flatten(tree.roots), ["coordinator", "native", "child", "independent"])
  assert.deepEqual(tree.roots.map(node => node.sessionId), ["coordinator", "independent"])
  assert(tree.roots.every(node => !node.parentSessionId))
  assert(!JSON.stringify(tree).includes("outside-mission"))
})

test("foreign, duplicate, oversized, incomplete and cyclic observations fail closed without leaking references", () => {
  const invalid = [
    [...family.members, ordinary("foreign", "elsewhere")],
    [...family.members, declared("foreign")],
    [...family.members, ordinary("foreign", "native", "elsewhere")],
    [...family.members, family.members[3]],
    family.members.filter(member => member.sessionId !== "independent"), [],
    [declared("coordinator", "native"), declared("native", "coordinator")],
    [declared("coordinator"), declared("native"), declared("independent"), ordinary("one", "foreign")],
    [declared("coordinator", "native"), declared("native", "coordinator"), declared("independent")],
    [declared("coordinator"), declared("native", "one"), ordinary("one", "native"), declared("independent")],
    [declared("coordinator"), declared("native", "one"), ordinary("one", "native")],
    [ordinary("one", "one")], [ordinary("one", "missing")],
    Array.from({ length: 265 }, (_, n) => ordinary(`child-${n}`, "native")),
  ]
  for (const members of invalid) {
    const tree = missionConversationTree(actors, { state: "observed", members })
    assert.equal(tree.known, false); assert.equal(tree.count, 3)
    assert.deepEqual(flatten(tree.roots), ["coordinator", "independent", "native"])
    assert(!JSON.stringify(tree).includes("foreign"))
  }
})

test("an observed declared actor can descend from an ordinary conversation and remain declared", () => {
  const tree = missionConversationTree(actors, { state: "observed", members: [
    declared("coordinator"), ordinary("bridge", "coordinator", "coordinator"), declared("native", "bridge"), ordinary("child", "native"), declared("independent"),
  ] })
  assert.equal(tree.known, true)
  assert.deepEqual(flatten(tree.roots), ["coordinator", "bridge", "native", "child", "independent"])
  assert.equal(tree.roots[0].children[0].children[0].actor?.sessionId, "native")
})

test("exact runtime statuses require authoritative knowledge; pending requests do not inherit family activity", () => {
  assert.equal(missionConversationRuntimeState(), "unknown")
  assert.equal(missionConversationRuntimeState({ status: "working", runtimeStatusKnown: false }), "unknown")
  assert.equal(missionConversationRuntimeState({ status: "idle" }), "unknown")
  for (const [status, expected] of [["working", "running"], ["idle", "idle"], ["compacting", "compacting"]] as const)
    assert.equal(missionConversationRuntimeState({ status, runtimeStatusKnown: true }), expected)
  assert.equal(missionConversationRuntimeState({ status: "idle", pendingForm: true }), "form")
  assert.equal(missionConversationRuntimeState({ status: "idle", pendingPermission: true }), "permission")
})

test("all ten locales own the new conversation labels without changing technical activity headings", async () => {
  const english = (await import("../lib/i18n/messages/en/mission-conversations.ts")).missionConversationMessages
  for (const locale of ["en", "de", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const messages = (await import(`../lib/i18n/messages/${locale}/mission-conversations.ts`)).missionConversationMessages as Record<string, string>
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(english).sort())
    assert(Object.values(messages).every(value => value.trim() && !value.includes("missions.control")))
    assert.match(messages["missions.control.conversations.familyState"], /\{state\}/)
    assert(!Object.prototype.hasOwnProperty.call(messages, "missions.control.activity.title"))
  }
})
