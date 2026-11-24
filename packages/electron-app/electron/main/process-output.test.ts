import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { tolerateBrokenPipe } from "./process-output"

test("ignores broken output pipes without hiding other stream errors", () => {
  const stream = new EventEmitter()
  tolerateBrokenPipe(stream)
  assert.doesNotThrow(() => stream.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" })))
  assert.throws(() => stream.emit("error", Object.assign(new Error("bad descriptor"), { code: "EBADF" })), /bad descriptor/)
})
