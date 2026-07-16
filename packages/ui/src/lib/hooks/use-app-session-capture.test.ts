import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8")

describe("app session capture listener readiness", () => {
  it("registers both Tauri flush listeners without delaying restore", () => {
    const capture = source("./use-app-session-capture.ts")
    const restore = source("./use-app-session-restore.ts")
    const ready = capture.slice(capture.indexOf("const ready ="), capture.indexOf("const markScrollAuthority"))
    assert.match(ready, /Promise\.all/)
    assert.match(ready, /client-state:flush-requested/)
    assert.match(ready, /client-state:navigation-flush-requested/)
    assert.doesNotMatch(restore, /await capture\.ready/)
  })

})
