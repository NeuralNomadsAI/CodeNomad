import assert from "node:assert/strict"
import test from "node:test"
import { humanDecisionRequired } from "./control-error"

test("the human-decision refusal keeps a fixed gate reason but never a raw system error", () => {
  const wrapped = (cause: Error) => Object.assign(new Error("An error occurred in Effect.tryPromise"), { cause })
  assert.match(humanDecisionRequired(wrapped(new Error("Human decision delegation is not this assignment"))).message,
    /\(Human decision delegation is not this assignment\)$/)
  const leaked = humanDecisionRequired(wrapped(new Error("ENOENT: no such file or directory, open 'C:\\Users\\me\\opencode.db'")))
  assert.doesNotMatch(leaked.message, /ENOENT|opencode\.db|Users/)
  assert.match(leaked.message, /native question tool if needed\.$/)
})
