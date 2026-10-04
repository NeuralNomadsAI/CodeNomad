import assert from "node:assert/strict"
import test from "node:test"
import { NativeBootstrap, NATIVE_BOOTSTRAP_REQUEST_PREFIX, NATIVE_BOOTSTRAP_REPLY_PREFIX } from "./native-bootstrap"

test("trusted native bootstrap requests return only a fresh correlated one-shot proof", () => {
  const lines: string[] = []
  let count = 0
  const bootstrap = new NativeBootstrap(true, () => `proof-${++count}`, { write: line => { lines.push(String(line)); return true } })
  for (const id of ["attach-one", "attach-two"]) bootstrap.handleLine(`${NATIVE_BOOTSTRAP_REQUEST_PREFIX}${JSON.stringify({ v: 1, id })}`)
  assert.deepEqual(lines.map(line => JSON.parse(line.slice(NATIVE_BOOTSTRAP_REPLY_PREFIX.length))), [
    { v: 1, id: "attach-one", ok: true, token: "proof-1" }, { v: 1, id: "attach-two", ok: true, token: "proof-2" },
  ])
})

test("bootstrap stays private, bounded and redacts issuance errors", () => {
  const lines: string[] = []
  let count = 0
  const output = { write: (line: string | Uint8Array) => { lines.push(String(line)); return true } }
  const issue = () => { count++; throw new Error("PRIVATE AUTH CONFIG") }
  const disabled = new NativeBootstrap(false, issue, output)
  const bootstrap = new NativeBootstrap(true, issue, output)
  const valid = `${NATIVE_BOOTSTRAP_REQUEST_PREFIX}${JSON.stringify({ v: 1, id: "nonce" })}`
  disabled.handleLine(valid)
  for (const value of ["broken", JSON.stringify({ v: 1, id: "unsafe\nID" }), JSON.stringify({ v: 1, id: "ok", arbitrary: true }), "x".repeat(1025)]) {
    bootstrap.handleLine(`${NATIVE_BOOTSTRAP_REQUEST_PREFIX}${value}`)
  }
  assert.equal(count, 0)
  assert.equal(bootstrap.handleLine("unrelated"), false)
  bootstrap.handleLine(valid)
  assert.equal(count, 1)
  assert.deepEqual(JSON.parse(lines[0].slice(NATIVE_BOOTSTRAP_REPLY_PREFIX.length)), { v: 1, id: "nonce", ok: false, error: "bootstrap-unavailable" })
  assert.ok(!lines[0].includes("PRIVATE"))
})
