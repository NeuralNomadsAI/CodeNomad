import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { appendNodeOption, DeveloperMode, developerModeMarkerPath } from "./developer-mode"

test("persists desired state separately from the startup snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "codenomad-developer-mode-"))
  const markerPath = developerModeMarkerPath(root)
  const mode = new DeveloperMode({
    active: false,
    devtoolsDataPath: root,
    nativeIdentity: "electron:test",
    targetWindowId: () => undefined,
    requestRelaunch: () => {},
    markerPath,
  })

  assert.deepEqual(mode.state(), { enabled: false, active: false })
  assert.deepEqual(await mode.setEnabled(true), { enabled: true, active: false })
  assert.deepEqual(await mode.setEnabled(false), { enabled: false, active: false })
  assert.equal(markerPath, join(root, ".config", "codenomad", "developer-mode"))
})

test("reports the current local window and schedules a graceful relaunch", async () => {
  const root = await mkdtemp(join(tmpdir(), "codenomad-developer-target-"))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, "DevToolsActivePort"), "43123\n/devtools/browser/test\n")
  let restart: (() => void) | undefined
  let relaunched = false
  const mode = new DeveloperMode({
    active: true,
    devtoolsDataPath: root,
    nativeIdentity: "electron:test",
    targetWindowId: () => "window-1",
    requestRelaunch: () => { relaunched = true },
    runId: "run-1",
    schedule: (callback) => { restart = callback },
  })

  assert.deepEqual(await mode.handleNativeRequest("developer.status"), {
    status: {
      state: "ready",
      runId: "run-1",
      nativeIdentity: "electron:test",
      cdpUrl: "http://127.0.0.1:43123",
      windowId: "window-1",
    },
    logs: [],
  })
  assert.deepEqual(await mode.handleNativeRequest("developer.restart"), {
    state: "starting",
    runId: "run-1",
    nativeIdentity: "electron:test",
    cdpUrl: "http://127.0.0.1:43123",
    windowId: undefined,
  })
  assert.equal(relaunched, false)
  restart!()
  assert.equal(relaunched, true)
})

test("adds source maps once", () => {
  assert.equal(appendNodeOption(undefined, "--enable-source-maps"), "--enable-source-maps")
  assert.equal(appendNodeOption("--trace-warnings --enable-source-maps", "--enable-source-maps"), "--trace-warnings --enable-source-maps")
})
