import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { appendNodeOption, DeveloperMode } from "./developer-mode"
import { developerNativeIdentity, developerRelaunchOptions, readDeveloperRelaunch, readElectronEntry } from "./developer-relaunch"

const restartId = "8d80a777-0085-48c8-b791-d3514bd63f32"
const windowId = "11111111-2222-4333-8444-555555555555"

test("native restart refuses an absent pinned window even in the right run and scope", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codenomad-automation-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  let restart: (() => void) | undefined
  let relaunched = false
  const mode = new DeveloperMode({
    devtoolsDataPath: root,
    nativeIdentity: "electron:test",
    windows: () => [],
    hasWindow: () => false,
    canRelaunch: () => true,
    requestRelaunch: () => { relaunched = true },
    schedule: (callback) => { restart = callback },
  })

  assert.equal((await mode.status()).state, "starting")
  await assert.rejects(mode.handleNativeRequest("developer.restartScope", {
    runId: (await mode.status()).runId, nativeIdentity: "electron:test", windowId, restartId,
  }))
  assert.equal(relaunched, false)
  assert.equal(restart, undefined)
})

test("admits only the inspected run, scope and exact window after focus changes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codenomad-developer-target-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, "DevToolsActivePort"), "43123\n/devtools/browser/test\n")
  let restart: (() => void) | undefined
  let relaunched: unknown
  const windowInstance = "first-incarnation"
  const first = { windowId, windowInstance, focused: true }
  const second = { windowId: "another-focused-window", windowInstance: "other-incarnation", focused: false }
  let windows = [first, second]
  const expected = { runId: "run-1", nativeIdentity: "electron:test", windowId, windowInstance, restartId }
  let canRelaunch = false
  const mode = new DeveloperMode({
    devtoolsDataPath: root,
    nativeIdentity: "electron:test",
    windows: () => windows,
    hasWindow: id => windows.some(window => window.windowId === id),
    canRelaunch: () => canRelaunch,
    requestRelaunch: (restart) => { relaunched = restart },
    runId: "run-1",
    schedule: (callback) => { restart = callback },
  })

  assert.deepEqual(await mode.handleNativeRequest("developer.status"), {
    status: {
      state: "ready",
      runId: "run-1",
      nativeIdentity: "electron:test",
      cdpUrl: "http://127.0.0.1:43123",
      windowId,
      windowInstance,
    },
    logs: [],
  })
  windows = [{ ...second, focused: true }, { ...first, focused: false }]
  assert.deepEqual((await mode.handleNativeRequest("developer.targets") as { windows: unknown }).windows, windows)
  const selection = { windowId, windowInstance, runId: "run-1" }
  assert.equal((await mode.status(selection)).windowId, windowId)
  assert.equal((await mode.status({ ...selection, runId: "old" })).state, "starting")
  assert.equal((await mode.status({ ...selection, windowInstance: "replaced" })).state, "starting")
  await assert.rejects(mode.handleNativeRequest("developer.restart", expected), /Unsupported/)
  for (const invalid of [{}, { ...expected, runId: "other" }, { ...expected, windowId: second.windowId },
    { ...expected, windowInstance: "replaced" },
    { ...expected, nativeIdentity: "other" }]) await assert.rejects(mode.handleNativeRequest("developer.restartScope", invalid))
  await assert.rejects(mode.handleNativeRequest("developer.restartScope", expected), /shutting down/)
  assert.equal(restart, undefined)
  canRelaunch = true
  assert.deepEqual(await mode.handleNativeRequest("developer.restartScope", expected), expected)
  await assert.rejects(mode.handleNativeRequest("developer.restartScope", expected), /already pending/)
  assert.equal(relaunched, undefined)
  windows[1] = { ...windows[1], windowInstance: "replaced" }
  restart!()
  assert.equal(relaunched, undefined, "a new incarnation of the same UUID cannot complete an admitted restart")
  windows[1] = first
  await mode.handleNativeRequest("developer.restartScope", expected)
  restart!()
  assert.deepEqual(relaunched, expected)
})

test("reconnect proves the one-shot handoff and never substitutes a focused window", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codenomad-developer-reconnect-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "DevToolsActivePort"), "43123\n")
  const previousRestart = { runId: "old", nativeIdentity: "electron:test", windowId, windowInstance: "old-incarnation", restartId }
  let restored: "missing" | "loading" | "ready" = "missing"
  const mode = new DeveloperMode({
    devtoolsDataPath: root, nativeIdentity: "electron:test", runId: "new", previousRestart,
    windows: () => [{ windowId: "focused", focused: true }, ...(restored === "ready"
      ? [{ windowId, windowInstance: "restored-incarnation", focused: false }] : [])],
    hasWindow: id => id === windowId && restored !== "missing",
    canRelaunch: () => true,
    requestRelaunch: () => assert.fail("read-only"),
  })
  await assert.rejects(mode.handleNativeRequest("developer.reconnect", { ...previousRestart, windowId: "focused" }))
  assert.deepEqual(await mode.handleNativeRequest("developer.reconnect", previousRestart), {
    status: { state: "missing", runId: "new", nativeIdentity: "electron:test", windowId, restartId }, logs: [],
  })
  restored = "loading"
  assert.deepEqual(await mode.handleNativeRequest("developer.reconnect", previousRestart), {
    status: { state: "starting", runId: "new", nativeIdentity: "electron:test", windowId, restartId }, logs: [],
  })
  restored = "ready"
  assert.deepEqual(await mode.handleNativeRequest("developer.reconnect", previousRestart), {
    status: { state: "ready", runId: "new", nativeIdentity: "electron:test", windowId, windowInstance: "restored-incarnation", restartId, cdpUrl: "http://127.0.0.1:43123" }, logs: [],
  })
})

test("superseding the native backend before shutdown cancels an admitted restart", async () => {
  let scheduled!: () => void
  let current = true
  const mode = new DeveloperMode({
    devtoolsDataPath: ".", nativeIdentity: "electron:test", runId: "run",
    windows: () => [{ windowId, focused: true }],
    hasWindow: () => true,
    canRelaunch: () => true,
    requestRelaunch: () => assert.fail("a retired backend must not relaunch the host"),
    schedule: (callback) => { scheduled = callback },
  })
  await mode.handleNativeRequest("developer.restartScope", { runId: "run", nativeIdentity: "electron:test", windowId, restartId },
    () => { if (!current) throw new Error("Backend superseded") })
  current = false
  scheduled()
})

test("the relaunch arguments pin only the original profile, config and artifact", () => {
  const config = join(tmpdir(), "A config", "legacy.json")
  const executable = "/bin/electron"
  const artifact = join(tmpdir(), "worktree-a", "electron")
  const launch = {
    profile: "default", pinned: true, config,
    restart: { runId: "old", windowId, restartId, nativeIdentity: developerNativeIdentity("default", "config.yaml", config, executable, artifact) },
  }
  const options = developerRelaunchOptions(launch, executable, readElectronEntry([executable, artifact])!.args)
  assert.equal(options.execPath, executable)
  assert.equal(options.args![0], artifact)
  assert.deepEqual(readDeveloperRelaunch(options.args!.slice(1)), launch)
  assert.throws(() => readDeveloperRelaunch([...options.args!.slice(1), "--new-window"]))
  assert.notEqual(developerNativeIdentity("stable", "config.yaml", config, executable, artifact), launch.restart.nativeIdentity)
  assert.notEqual(developerNativeIdentity("default", "config.yaml", undefined, executable, artifact), launch.restart.nativeIdentity)
  assert.notEqual(developerNativeIdentity("default", "config.yaml", config, executable, join(tmpdir(), "worktree-b", "electron")), launch.restart.nativeIdentity)
})

test("a relative Electron CLI file entry relaunches as the same absolute file with only the handoff", () => {
  const executable = process.execPath
  const entry = fileURLToPath(new URL("./main.ts", import.meta.url))
  const appEntry = relative(process.cwd(), entry)
  const identity = (path: string) => developerNativeIdentity("dev", "config.yaml", undefined, executable, path)
  const launch = { profile: "dev", pinned: true, config: null, restart: { runId: "old", windowId, restartId, nativeIdentity: identity(appEntry) } }
  const { args } = developerRelaunchOptions(launch, executable, readElectronEntry([executable, appEntry, "--new-window", "--connect-server=local", "--folder=."])!.args)
  assert.ok(args)
  assert.equal(args[0], entry)
  assert.equal(createRequire(import.meta.url).resolve(args[0]), entry)
  assert.deepEqual(readDeveloperRelaunch(args.slice(1)), launch)
  assert.equal(identity(args[0]), launch.restart.nativeIdentity)
})

test("Electron CLI resolves the same app entry for identity, launch intents and scoped restart", () => {
  const executable = process.execPath
  const entry = fileURLToPath(new URL("./main.ts", import.meta.url))
  const relativeEntry = relative(process.cwd(), entry)
  const identity = (path: string) => developerNativeIdentity("dev", "config.yaml", undefined, executable, path)
  const intents = ["--new-window", "--connect-server=local", "--folder=."]
  for (const prefix of [
    ["--require", "init.js", "--no-sandbox", relativeEntry],
    ["-r", "init.js", "--no-sandbox", relativeEntry],
    ["--no-sandbox", `--app=${relativeEntry}`],
    ["--no-sandbox", "-r", "--app=preload.js", `--app=${relativeEntry}`],
  ]) {
    const argv = [executable, ...prefix, ...intents]
    const current = readElectronEntry(argv)!
    assert.equal(current.path, entry)
    assert.deepEqual(argv.slice(current.nextIndex), intents)
    const launch = { profile: "dev", pinned: true, config: null, restart: {
      runId: "old", windowId, restartId, nativeIdentity: identity(current.path),
    } }
    const { args } = developerRelaunchOptions(launch, executable, current.args)
    assert.deepEqual(args?.slice(0, 2), ["--no-sandbox", entry])
    const successorArgv = [executable, ...args!]
    const successor = readElectronEntry(successorArgv)!
    assert.equal(identity(successor.path), launch.restart.nativeIdentity)
    assert.deepEqual(readDeveloperRelaunch(successorArgv.slice(successor.nextIndex)), launch)
  }
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
