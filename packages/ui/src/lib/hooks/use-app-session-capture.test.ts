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

  it("lets the exact restored active tab replace non-user startup selection", () => {
    const restore = source("./use-app-session-restore.ts")
    assert.match(restore, /if \(!requested && \(current \|\| ownedActiveTabId\)\) return/)
    assert.ok(restore.indexOf("appTabSelectionRevision() !== selectionRevision") < restore.indexOf("selectAppTab(tabId"))
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

  it("does not overwrite the native shutdown flush during teardown", () => {
    const capture = source("./use-app-session-capture.ts")
    const start = capture.lastIndexOf("onCleanup(() => {")
    const cleanup = capture.slice(start, capture.indexOf("return {", start))
    assert.match(cleanup, /disposed = true/)
    assert.match(cleanup, /if \(timer\) clearTimeout\(timer\)/)
    assert.doesNotMatch(cleanup, /flush\(\)/)
  })

  it("uses browser lifecycle flushes only when no local native host owns shutdown", () => {
    const capture = source("./use-app-session-capture.ts")
    assert.match(capture, /const useBrowserLifecycleFlush = !isLocalWindow\(\)/)
    assert.match(capture, /if \(useBrowserLifecycleFlush\) \{\s*window\.addEventListener\("pagehide"/)
  })

  it("does not replace settled tabs with transient teardown state during a native flush", () => {
    const capture = source("./use-app-session-capture.ts")
    assert.match(capture, /nativeShutdown\s*&& current\.tabs\.length === 0/)
    assert.match(capture, /\(nativeFallbackState\?\.tabs\.length \?\? 0\) > 0/)
    assert.match(capture, /void flush\(true\)\.then/)
  })

  it("makes native shutdown terminal for later reactive captures", () => {
    const capture = source("./use-app-session-capture.ts")
    assert.match(capture, /if \(nativeShutdown\) nativeShutdownStarted = true/)
    assert.match(capture, /if \(!enabled\(\) \|\| disposed \|\| nativeShutdownStarted\) return/)
    assert.match(capture, /enabled\(\) && !disposed && !nativeShutdownStarted/)
  })

  it("clears the native fallback only after an authoritative workspace removal", () => {
    const capture = source("./use-app-session-capture.ts")
    const removed = capture.slice(capture.indexOf('if (event.type === "removed")'), capture.indexOf("} else {", capture.indexOf('if (event.type === "removed")')))
    assert.match(removed, /markPreservedWorkspaceRemoved/)
    assert.match(removed, /nativeFallbackState = authoritativeState\.tabs\.length > 0 \? authoritativeState : null/)
  })
})
