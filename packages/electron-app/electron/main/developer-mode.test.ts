import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { appendNodeOption, DeveloperMode } from "./developer-mode"

test("normal startup waits for CDP and can restart without an enable marker", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codenomad-automation-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  let restart: (() => void) | undefined
  let relaunched = false
  const mode = new DeveloperMode({
    devtoolsDataPath: root,
    nativeIdentity: "electron:test",
    targetWindowId: () => undefined,
    requestRelaunch: () => { relaunched = true },
    schedule: (callback) => { restart = callback },
  })

  assert.equal((await mode.status()).state, "starting")
  await mode.handleNativeRequest("developer.restart")
  assert.equal(relaunched, false)
  restart!()
  assert.equal(relaunched, true)
})

test("reports the current local window and schedules a graceful relaunch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codenomad-developer-target-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, "DevToolsActivePort"), "43123\n/devtools/browser/test\n")
  let restart: (() => void) | undefined
  let relaunched = false
  const mode = new DeveloperMode({
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

test("normal Electron startup always provisions isolated loopback instrumentation", async () => {
  const source = await readFile(new URL("./main.ts", import.meta.url), "utf8")
  assert.match(source, /appendSwitch\("remote-debugging-address", "127\.0\.0\.1"\)/)
  assert.match(source, /appendSwitch\("remote-debugging-port", "0"\)/)
  assert.match(source, /const browserDataPath = join\(scope\.userDataPath, "developer-mode-browser-v2"\)/)
  assert.match(source, /startPrimaryInstance\([\s\S]*?configureBrowserStorage\(browserDataPath, sessionDataPath\)/)
  assert.doesNotMatch(source, /readDeveloperModeEnabled|developerModeActive|CODENOMAD_DEVELOPER_MODE/)
})

test("adds source maps once", () => {
  assert.equal(appendNodeOption(undefined, "--enable-source-maps"), "--enable-source-maps")
  assert.equal(appendNodeOption("--trace-warnings --enable-source-maps", "--enable-source-maps"), "--trace-warnings --enable-source-maps")
})
