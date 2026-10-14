import assert from "node:assert/strict"
import { test } from "node:test"
import { verifyNativeWindowResult } from "./fixtures/tauri-macos-window-result.mjs"

const boundary = "BEGIN: borderless getter feedback probe\n"
const result = (overrides = {}) => ({ status: 2, signal: null, stdout: boundary,
  stderr: "FAIL: getter event feedback watchdog: phase=1 captures=1000\n", ...overrides })

test("accepts only a getter-boundary feedback watchdog or read-generated event assertion", () => {
  verifyNativeWindowResult(result(), true)
  verifyNativeWindowResult(result({ status: 101, stderr: "normal reads generated geometry events" }), true)
})

test("rejects setup stalls, generic watchdogs, later-phase timeouts and insufficient capture evidence", () => {
  for (const invalid of [
    result({ stdout: "" }),
    result({ stderr: "FAIL: native window event feedback watchdog" }),
    result({ stderr: "FAIL: getter event feedback watchdog: phase=2 captures=1000" }),
    result({ stderr: "FAIL: getter event feedback watchdog: phase=1 captures=2" }),
    result({ status: 101, stderr: "maximize must remain functional" }),
    result({ status: 0 }),
    result({ status: null, signal: "SIGTERM" }),
    result({ error: new Error("spawn failed") }),
  ]) assert.throws(() => verifyNativeWindowResult(invalid, true))
})

test("patched result requires successful exit and native completion evidence", () => {
  verifyNativeWindowResult(result({ status: 0, stdout: "PASS: read-only zoom checks", stderr: "" }))
  assert.throws(() => verifyNativeWindowResult(result({ status: 0, stdout: "" })))
  assert.throws(() => verifyNativeWindowResult(result()))
})
