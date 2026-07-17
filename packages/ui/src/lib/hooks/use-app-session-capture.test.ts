import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8")

describe("app session capture listener readiness", () => {
  it("waits for both Tauri flush listeners before restore starts capture", () => {
    const capture = source("./use-app-session-capture.ts")
    const restore = source("./use-app-session-restore.ts")
    const ready = capture.slice(capture.indexOf("const ready ="), capture.indexOf("const markScrollAuthority"))
    assert.match(ready, /Promise\.all/)
    assert.match(ready, /client-state:flush-requested/)
    assert.match(ready, /client-state:navigation-flush-requested/)
    assert.ok(restore.indexOf("await capture.ready") < restore.indexOf("capture.start("))
  })

  it("serializes missing workspace mounts during session restore", () => {
    const restore = source("./use-app-session-restore.ts")
    assert.match(restore, /for \(const group of groups\.values\(\)\) for \(const match of group\) await restoreWorkspace\(match\)/)
    assert.doesNotMatch(restore, /Array\.from\(groups\.values\(\), async/)
  })

})
