import assert from "node:assert/strict"
import test from "node:test"
import { isConnectionRefused } from "./connection-errors"

test("only explicit refused connections prove endpoint absence", () => {
  const refused = { code: "ECONNREFUSED" }
  assert.equal(isConnectionRefused(refused), true)
  assert.equal(isConnectionRefused({ code: "ConnectionRefused" }), true)
  assert.equal(isConnectionRefused({ cause: refused }), true)
  assert.equal(isConnectionRefused(new AggregateError([refused, { cause: refused }], "unavailable")), true)
  for (const error of [null, "ECONNREFUSED", new Error("ECONNREFUSED"), { code: "ETIMEDOUT" },
    new AggregateError([refused, { code: "ETIMEDOUT" }], "incomplete"), { code: "EACCES" }]) {
    assert.equal(isConnectionRefused(error), false)
  }
})
