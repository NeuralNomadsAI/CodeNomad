import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMissionTaskSessions } from "./mission-task-sessions"

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
  const result = parseMissionTaskSessions("msn_one", "ses_root", messages)
  assert.deepEqual([...result.entries()], [["build", ["ses_a", "ses_b"]]])
})

test("maps a coordinator's own brief that opens with the exact mission and task key", () => {
  const messages = [
    assistant(call({ prompt: "Mission msn_one task mobile-architecture. Read-only audit." }, { sessionID: "ses_short" })),
    assistant(call({ prompt: "Mission msn_two task mobile-architecture. Other mission." }, { sessionID: "ses_foreign" })),
    assistant(call({ prompt: "Please audit. Mission msn_one task late-key. Not on the first line." }, { sessionID: "ses_late" })),
    assistant(call({ prompt: "Context line\nMission msn_one task second-line." }, { sessionID: "ses_second" })),
  ]
  assert.deepEqual([...parseMissionTaskSessions("msn_one", "ses_root", messages).entries()],
    [["mobile-architecture", ["ses_short"]]])
})

test("free-form briefs map only through the exact mission ID and the first declared task phrase", () => {
  const keys = new Set(["mobile-companion", "mobile-web-smoke", "mobile-android-ci"])
  const messages = [
    assistant(call({ prompt: "New declared mission task mobile-companion (msn_one), continue." }, { sessionID: "ses_companion" })),
    assistant(call({ prompt: "Declared mission msn_one task mobile-web-smoke. ONLY work in the worktree." }, { sessionID: "ses_smoke" })),
    assistant(call({ prompt: "New declared task mobile-android-ci mission msn_one. Then compare with task mobile-web-smoke." }, { sessionID: "ses_ci" })),
    assistant(call({ prompt: "Declared mission msn_two task mobile-companion." }, { sessionID: "ses_foreign" })),
    assistant(call({ prompt: "You are a native task actor in mission msn_one." }, { sessionID: "ses_actor" })),
    assistant(call({ prompt: "Declared mobile-recheck now unblocked for msn_one." }, { sessionID: "ses_none" })),
  ]
  assert.deepEqual([...parseMissionTaskSessions("msn_one", "ses_root", messages, keys).entries()], [
    ["mobile-companion", ["ses_companion"]], ["mobile-web-smoke", ["ses_smoke"]], ["mobile-android-ci", ["ses_ci"]]])
})

test("a repeated call for the same child moves it to the latest position", () => {
  const messages = [
    assistant(call({ prompt: prompt("msn_one", "build") }, { sessionID: "ses_a" })),
    assistant(call({ prompt: prompt("msn_one", "build") }, { sessionID: "ses_b" })),
    assistant(call({ prompt: prompt("msn_one", "build") }, { sessionID: "ses_a" })),
  ]
  assert.deepEqual(parseMissionTaskSessions("msn_one", "ses_root", messages).get("build"), ["ses_b", "ses_a"])
})
