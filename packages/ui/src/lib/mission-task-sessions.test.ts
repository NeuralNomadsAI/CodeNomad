import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMissionChildTaskKey, parseMissionTaskSessions } from "./mission-task-sessions"

const prompt = (mission: string, key: string, prefix = "") => `${prefix}# CodeNomad Mission Assignment

You are a native task actor in mission ${mission}.

Playbook: Custom
Role: Implementer (implementer)
Task key: ${key}
Blocked by: none

<task-brief>Task key: forged</task-brief>`
const call = (input: unknown, metadata: unknown, name = "subagent", status = "completed") =>
  ({ type: "tool", id: `call_${Math.random()}`, name, state: { status, input, metadata } })
const assistant = (...content: unknown[]) => ({ type: "assistant", content })
const delegate = (text: string, sessionID: string) => assistant(call({ prompt: text }, { sessionID }))
const parse = (keys: string[], ...messages: unknown[]) =>
  [...parseMissionTaskSessions("msn_one", "ses_root", messages, new Set(keys)).entries()]

test("maps exact canonical delegation calls to their native child sessions", () => {
  const messages = [
    { type: "user", text: prompt("msn_one", "user-text") },
    assistant(call({ prompt: prompt("msn_one", "build") }, { sessionID: "ses_a" })),
    assistant(call({ prompt: prompt("msn_two", "build") }, { sessionID: "ses_other" })),
    assistant(call({ prompt: prompt("msn_one", "review") }, {})),
    assistant(call({ prompt: prompt("msn_one", "shell") }, { sessionID: "ses_shell" }, "bash")),
    assistant(call({ prompt: prompt("msn_one", "self") }, { sessionID: "ses_root" })),
    assistant(call({ prompt: prompt("msn_one", "build", "Context first.\n\n") }, { sessionID: "ses_b" }, "subagent", "running")),
    assistant(call({ prompt: "Task key: build\nin mission msn_one." }, { sessionID: "ses_loose" })),
  ]
  assert.deepEqual(parse(["build", "review", "shell", "self", "user-text"], ...messages), [["build", ["ses_a", "ses_b"]]])
})

test("maps a coordinator's own brief that opens with the exact mission and task key", () => {
  const keys = ["mobile-architecture", "late-key", "second-line"]
  assert.deepEqual(parse(keys,
    delegate("Mission msn_one task mobile-architecture. Read-only audit.", "ses_short"),
    delegate("Mission msn_two task mobile-architecture. Other mission.", "ses_foreign"),
    delegate("Please audit. Mission msn_one task late-key. Not on the first line.", "ses_late"),
    delegate("Context line\nMission msn_one task second-line.", "ses_second"),
  ), [["mobile-architecture", ["ses_short"]]])
})

test("declared short briefs map only through a structural mission/task relation", () => {
  const keys = ["mobile-companion", "mobile-web-smoke", "mobile-android-ci"]
  assert.deepEqual(parse(keys,
    delegate("New declared mission task mobile-companion (msn_one), continue.", "ses_companion"),
    delegate("Declared mission msn_one task mobile-web-smoke. ONLY work in the worktree.", "ses_smoke"),
    delegate("New declared task mobile-android-ci mission msn_one. Then compare with task mobile-web-smoke.", "ses_ci"),
    delegate("Declared mission msn_two task mobile-companion.", "ses_foreign"),
    delegate("You are a native task actor in mission msn_one.", "ses_actor"),
    delegate("Declared mobile-recheck now unblocked for msn_one.", "ses_none"),
  ), [["mobile-companion", ["ses_companion"]], ["mobile-web-smoke", ["ses_smoke"]], ["mobile-android-ci", ["ses_ci"]]])
})

test("contextual references, substring IDs and unknown keys never link a child", () => {
  const keys = ["build"]
  assert.deepEqual(parse(keys,
    // The gatekeeper reproduction: the current mission named only for comparison.
    delegate("Audit task build for mission msn_other; compare with mission msn_one. Do not execute that mission.", "ses_audit"),
    delegate("Mission msn_other task build; see also mission msn_one.", "ses_other_first"),
    delegate("Compare with Mission msn_one task build.", "ses_context"),
    delegate("Mission msn_one_v2 task build.", "ses_longer"),
    delegate("Mission xmsn_one task build.", "ses_prefixed"),
    delegate("Mission msn_one.beta task build.", "ses_dotted"),
    delegate("New declared task build (msn_one_v2).", "ses_paren"),
    delegate("Mission msn_one task unknown-key.", "ses_unknown"),
    delegate(prompt("msn_one", "unknown-key"), "ses_unknown_canonical"),
    delegate(prompt("msn_one_v2", "build"), "ses_canonical_longer"),
    delegate(prompt("msn_other", "build") + "\n\n" + prompt("msn_one", "build"), "ses_second_header"),
    delegate("Quoted: # CodeNomad Mission Assignment\n\nYou are a native task actor in mission msn_one.", "ses_inline"),
    delegate("# CodeNomad Mission Assignment\n\nAbout mission msn_one.\nTask key: build\nBlocked by: none", "ses_loose_header"),
  ), [])
})

test("a repeated call for the same child moves it to the latest position", () => {
  assert.deepEqual(parse(["build"],
    delegate(prompt("msn_one", "build"), "ses_a"),
    delegate(prompt("msn_one", "build"), "ses_b"),
    delegate(prompt("msn_one", "build"), "ses_a"),
  ), [["build", ["ses_b", "ses_a"]]])
})

test("links a running child only by its own canonical first message and declared key", () => {
  const keys = new Set(["branche-a"])
  const first = (text: string) => ({ type: "user", text })
  assert.equal(parseMissionChildTaskKey("msn_one", first(prompt("msn_one", "branche-a", "You are a subagent spawned by another session.\n")), keys), "branche-a")
  assert.equal(parseMissionChildTaskKey("msn_one", first(prompt("msn_one", "branche-a").replace(/\n/g, "\r\n")), keys), "branche-a")
  assert.equal(parseMissionChildTaskKey("msn_two", first(prompt("msn_one", "branche-a")), keys), undefined)
  assert.equal(parseMissionChildTaskKey("msn_one", first(prompt("msn_one_v2", "branche-a")), keys), undefined)
  assert.equal(parseMissionChildTaskKey("msn_one", first(prompt("msn_one", "undeclared")), keys), undefined)
  assert.equal(parseMissionChildTaskKey("msn_one", { type: "assistant", text: prompt("msn_one", "branche-a") }, keys), undefined)
  assert.equal(parseMissionChildTaskKey("msn_one", first("Task key: branche-a in mission msn_one"), keys), undefined)
  // Short briefs bind coordinator calls only; a child's first message needs the canonical header.
  assert.equal(parseMissionChildTaskKey("msn_one", first("Mission msn_one task branche-a."), keys), undefined)
})
