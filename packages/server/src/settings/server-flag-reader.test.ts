import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { ServerFlagReader } from "./server-flag-reader"

function configFile(t: { after: (fn: () => void) => void }, content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-flag-reader-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "config.yaml")
  fs.writeFileSync(file, content)
  return file
}

test("a read that fails while the file is locked is retried on the next call", t => {
  const file = configFile(t, "server:\n  sidecarsOverDirectHttps: true\n")
  const read = fs.readFileSync
  let locked = true
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (locked && args[0] === file) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" })
    return read(...args)
  })
  const reader = new ServerFlagReader(file)
  assert.equal(reader.enabled("sidecarsOverDirectHttps"), false)
  assert.equal(reader.enabled("multiBackend", ["ui", "settings"], true), false)
  locked = false
  assert.equal(reader.enabled("sidecarsOverDirectHttps"), true)
  assert.equal(reader.enabled("multiBackend", ["ui", "settings"], true), true)
})

test("an invalid document reads as false until the file changes", t => {
  const file = configFile(t, "server: [unclosed\n")
  const reader = new ServerFlagReader(file)
  assert.equal(reader.enabled("sidecarsOverDirectHttps"), false)
  fs.writeFileSync(file, "server:\n  sidecarsOverDirectHttps: true\n")
  assert.equal(reader.enabled("sidecarsOverDirectHttps"), true)
})

test("nested UI admission flags follow authoritative strict boolean changes", t => {
  const file = configFile(t, "ui:\n  settings:\n    locale: en\n")
  const reader = new ServerFlagReader(file)
  const enabled = () => reader.enabled("multiBackend", ["ui", "settings"], true)
  assert.equal(enabled(), true)
  for (const [value, expected] of [["true", true], ["false", false], ["'true'", false], ["null", false]] as const) {
    fs.writeFileSync(file, `ui:\n  settings:\n    multiBackend: ${value}\n`)
    assert.equal(enabled(), expected)
  }
  fs.writeFileSync(file, "ui: [unclosed\n")
  assert.equal(enabled(), false)
  fs.writeFileSync(file, "null\n")
  assert.equal(enabled(), false)
  fs.writeFileSync(file, "# empty settings\n")
  assert.equal(enabled(), true)
  fs.unlinkSync(file)
  assert.equal(enabled(), true)
})
