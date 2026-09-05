import assert from "node:assert/strict"
import test from "node:test"
import { clientWebSocketCloseCode } from "./websocket-close"

test("client close codes preserve permitted values and normalize reserved codes", () => {
  for (const code of [undefined, 1000, 3000, 4001, 4999]) {
    assert.equal(clientWebSocketCloseCode(code), code)
  }
  for (const code of [1002, 1003, 1008, 1009, 1012, 1013, 5000, 3000.5, NaN]) {
    assert.equal(clientWebSocketCloseCode(code), 4000)
  }
})
