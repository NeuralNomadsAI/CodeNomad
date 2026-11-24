import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { resolveHost } from "./index"

describe("CLI shutdown wiring", () => {
  it("installs the shared adapters and forwards stdin lines to the native parent", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    assert.match(source, /import\s*\{[^}]*\binstallShutdownSignalHandlers\b[^}]*\binstallShutdownStdinHandler\b[^}]*\}\s*from "\.\/shutdown"/)
    assert.match(source, /installShutdownSignalHandlers\(process, shutdown\)/)
    assert.match(source, /installShutdownStdinHandler\(process\.stdin, shutdown, \(line\) => nativeParent\.handleLine\(line\)\)/)
  })
})

describe("CLI host normalization", () => {
  it("normalizes mapped and internationalized hosts and rejects IPv6 zones", () => {
    assert.equal(resolveHost("::ffff:0:0"), "0.0.0.0")
    assert.equal(resolveHost("::ffff:7f00:1"), "127.0.0.1")
    assert.equal(resolveHost("münchen.local"), "xn--mnchen-3ya.local")
    assert.throws(() => resolveHost("fe80::1%12"), /IPv6 zone identifiers/)
  })
})
