import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

describe("Tauri loading navigation authority", () => {
  it("leaves ready navigation to the native host", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")

    assert.doesNotMatch(source, /window\.location\.(?:replace|assign)/)
    assert.doesNotMatch(source, /listen\(["']cli:ready["']/)
    assert.match(source, /invoke<CliStatus>\(["']cli_get_status["']\)/)
  })
})
