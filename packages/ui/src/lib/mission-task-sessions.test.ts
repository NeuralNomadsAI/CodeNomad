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

test("a repeated call for the same child moves it to the latest position", () => {
  const messages = [
    assistant(call({ prompt: prompt("msn_one", "build") }, { sessionID: "ses_a" })),
    assistant(call({ prompt: prompt("msn_one", "build") }, { sessionID: "ses_b" })),
    assistant(call({ prompt: prompt("msn_one", "build") }, { sessionID: "ses_a" })),
  ]
  assert.deepEqual(parseMissionTaskSessions("msn_one", "ses_root", messages).get("build"), ["ses_b", "ses_a"])
})
