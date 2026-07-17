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

  it("uses the serialized commit queue without serializing create requests", () => {
    const restore = source("./use-app-session-restore.ts")
    assert.match(restore, /runWithSerializedCommits/)
    assert.match(restore, /waitForCreateCommit/)
    assert.doesNotMatch(restore, /for \(const match of missing\) await restoreWorkspace/)
  })

  it("does not track prompt hydration writes in the capture effect", () => {
    const capture = source("./use-app-session-capture.ts")
    assert.match(capture, /untrack\(\(\) => hydratePreservedPrompts/)
  })

  it("reapplies full preserved state after transient reopen hydration", () => {
    const capture = source("./use-app-session-capture.ts")
    assert.match(capture, /waitForInstanceInitialSessionHydration/)
    assert.match(capture, /hydrateRestoredWorkspaceState/)
    assert.match(capture, /settlePreservedTab/)
  })

})
