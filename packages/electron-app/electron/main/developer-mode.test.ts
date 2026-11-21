import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { createRequire, Module } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { appendNodeOption, DeveloperMode } from "./developer-mode"
import { developerNativeIdentity, developerRelaunchOptions, pinElectronRelaunch, readDeveloperRelaunch, readElectronEntry, verifyElectronRelaunch } from "./developer-relaunch"

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
    relaunchScopeGeneration: () => 0,
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
    relaunchScopeGeneration: () => canRelaunch ? 0 : undefined,
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
  let uptime = 95
  let expireDuringRead = false
  context.mock.method(process, "uptime", () => uptime)
  const mode = new DeveloperMode({
    devtoolsDataPath: root, nativeIdentity: "electron:test", runId: "new", previousRestart,
    windows: () => {
      if (expireDuringRead) uptime = 190
      return [{ windowId: "focused", focused: true }, ...(restored === "ready"
        ? [{ windowId, windowInstance: "restored-incarnation", focused: false }] : [])]
    },
    hasWindow: id => id === windowId && restored !== "missing",
    relaunchScopeGeneration: () => 0,
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
  uptime = 189.999
  assert.deepEqual(await mode.handleNativeRequest("developer.reconnect", previousRestart), {
    status: { state: "ready", runId: "new", nativeIdentity: "electron:test", windowId, windowInstance: "restored-incarnation", restartId, cdpUrl: "http://127.0.0.1:43123" }, logs: [],
  })
  expireDuringRead = true
  await assert.rejects(mode.handleNativeRequest("developer.reconnect", previousRestart), /No matching CodeNomad relaunch/)
  await assert.rejects(mode.handleNativeRequest("developer.reconnect", previousRestart), /No matching CodeNomad relaunch/)
})

test("superseding the native backend before shutdown cancels an admitted restart", async () => {
  let scheduled!: () => void
  let current = true
  const mode = new DeveloperMode({
    devtoolsDataPath: ".", nativeIdentity: "electron:test", runId: "run",
    windows: () => [{ windowId, focused: true }],
    hasWindow: () => true,
    relaunchScopeGeneration: () => 0,
    requestRelaunch: () => assert.fail("a retired backend must not relaunch the host"),
    schedule: (callback) => { scheduled = callback },
  })
  await mode.handleNativeRequest("developer.restartScope", { runId: "run", nativeIdentity: "electron:test", windowId, restartId },
    () => { if (!current) throw new Error("Backend superseded") })
  current = false
  scheduled()
})

test("checking the artifact reserves the request and rechecks the exact window before admission", async () => {
  let finish!: () => void
  let incarnation = "original"
  const mode = new DeveloperMode({
    devtoolsDataPath: ".", nativeIdentity: "electron:test", runId: "run",
    windows: () => [{ windowId, focused: true, windowInstance: incarnation }],
    hasWindow: () => true,
    relaunchScopeGeneration: () => 0,
    verifyRelaunch: () => new Promise<void>(resolve => { finish = resolve }),
    requestRelaunch: () => assert.fail("the replaced window must not relaunch"),
    schedule: () => assert.fail("the replaced window must not be admitted"),
  })
  const request = { runId: "run", nativeIdentity: "electron:test", windowId, windowInstance: incarnation, restartId }
  const admission = mode.handleNativeRequest("developer.restartScope", request)
  await assert.rejects(mode.handleNativeRequest("developer.restartScope", request), /already pending/)
  incarnation = "replacement"
  finish()
  await assert.rejects(admission, /window or run changed/)
})

test("the relaunch arguments pin only the original profile, config and artifact", () => {
  const config = join(tmpdir(), "A config", "legacy.json")
  const executable = process.execPath
  const entryPath = fileURLToPath(new URL("./main.ts", import.meta.url))
  const artifact = pinElectronRelaunch(executable, dirname(entryPath), [entryPath], entryPath)
  const launch = {
    profile: "default", pinned: true, config,
    restart: { runId: "old", windowId, restartId, nativeIdentity: developerNativeIdentity("default", "config.yaml", config, artifact) },
  }
  const options = developerRelaunchOptions(launch, artifact)
  assert.equal(options.execPath, artifact.execPath)
  assert.equal(options.args![0], artifact.mainPath)
  assert.deepEqual(readDeveloperRelaunch(options.args!.slice(1)), launch)
  assert.throws(() => readDeveloperRelaunch([...options.args!.slice(1), "--new-window"]))
  assert.notEqual(developerNativeIdentity("stable", "config.yaml", config, artifact), launch.restart.nativeIdentity)
  assert.notEqual(developerNativeIdentity("default", "config.yaml", undefined, artifact), launch.restart.nativeIdentity)
  assert.notEqual(developerNativeIdentity("default", "config.yaml", config,
    pinElectronRelaunch(executable, dirname(entryPath), [], fileURLToPath(import.meta.url))), launch.restart.nativeIdentity)
})

test("a relative Electron CLI file entry relaunches as the same absolute file with only the handoff", () => {
  const executable = process.execPath
  const entry = fileURLToPath(new URL("./main.ts", import.meta.url))
  const appEntry = relative(process.cwd(), entry)
  const current = readElectronEntry([executable, appEntry, "--new-window", "--connect-server=local", "--folder=."])!
  const artifact = pinElectronRelaunch(executable, dirname(entry), current.args, entry)
  const identity = (path: string) => developerNativeIdentity("dev", "config.yaml", undefined, pinElectronRelaunch(executable, dirname(entry), [], path))
  const launch = { profile: "dev", pinned: true, config: null, restart: { runId: "old", windowId, restartId, nativeIdentity: identity(appEntry) } }
  const { args } = developerRelaunchOptions(launch, artifact)
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
  const identity = (path: string) => developerNativeIdentity("dev", "config.yaml", undefined, pinElectronRelaunch(executable, dirname(entry), [], path))
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
    const { args } = developerRelaunchOptions(launch, pinElectronRelaunch(executable, dirname(entry), current.args, entry))
    assert.deepEqual(args?.slice(0, 2), ["--no-sandbox", entry])
    const successorArgv = [executable, ...args!]
    const successor = readElectronEntry(successorArgv)!
    assert.equal(identity(successor.path), launch.restart.nativeIdentity)
    assert.deepEqual(readDeveloperRelaunch(successorArgv.slice(successor.nextIndex)), launch)
  }
})

test("repointing a junction to a direct Electron entry cannot retarget the relaunch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codenomad-relaunch-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const [original, replacement, alias] = ["original", "replacement", "current"].map(name => join(root, name))
  await mkdir(original)
  await mkdir(replacement)
  for (const folder of [original, replacement]) {
    await writeFile(join(folder, "package.json"), "{}")
    await writeFile(join(folder, "electron.exe"), "")
    await writeFile(join(folder, "index.js"), "")
  }
  await symlink(original, alias, "junction")
  const executable = join(alias, "electron.exe")
  const entry = readElectronEntry([executable, "--no-sandbox", join(alias, "index.js")])!
  const main = resolveElectronMain(entry.path)
  const artifact = pinElectronRelaunch(executable, dirname(main), entry.args, main)
  const identity = (value: typeof artifact) => developerNativeIdentity("dev", "config.yaml", undefined, value)
  const launch = { profile: "dev", pinned: true, config: null, restart: {
    runId: "old", windowId, restartId, nativeIdentity: identity(artifact),
  } }

  await unlink(alias)
  await symlink(replacement, alias, "junction")
  await verifyElectronRelaunch(artifact)
  const { execPath, args } = developerRelaunchOptions(launch, artifact)
  assert.equal(await realpath(execPath!), await realpath(join(original, "electron.exe")))
  const successor = readElectronEntry([execPath!, ...args!])!
  assert.equal(successor.path, main)
  const successorMain = resolveElectronMain(successor.path)
  assert.equal(dirname(successorMain), artifact.appPath)
  assert.equal(identity(pinElectronRelaunch(execPath!, dirname(successorMain), successor.args, successorMain)), launch.restart.nativeIdentity)
  assert.notEqual(identity(pinElectronRelaunch(executable, alias, [], join(replacement, "index.js"))), launch.restart.nativeIdentity)
})

// Mirrors Electron's default_app/main.ts, without evaluating the resolved file.
const resolveElectronMain = (path: string) => (Module as typeof Module & {
  _resolveFilename(path: string, parent: null, isMain: true): string
})._resolveFilename(path, null, true)

for (const packaged of [false, true]) {
  test(`a ${packaged ? "packaged" : "CLI directory"} launch refuses before shutdown can load a changed package main`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "codenomad-package-relaunch-"))
    context.after(() => rm(root, { recursive: true, force: true }))
    const appPath = packaged ? join(root, "resources", "app") : root
    await mkdir(appPath, { recursive: true })
    const manifest = join(appPath, "package.json")
    const original = { name: "Fixture", version: "1.0.0", desktopName: "Fixture.desktop", main: "a.js" }
    writeFileSync(manifest, JSON.stringify(original))
    for (const name of ["a.js", "b.js"]) await writeFile(join(appPath, name), "")
    const artifact = pinElectronRelaunch(process.execPath, appPath, packaged ? [] : [appPath], join(appPath, original.main))
    const nativeIdentity = developerNativeIdentity("dev", "config.yaml", undefined, artifact)
    const restart = { runId: "old", windowId, restartId, nativeIdentity }
    let loadedEntry: string | undefined
    const mode = new DeveloperMode({
      devtoolsDataPath: root, nativeIdentity, runId: "old",
      windows: () => [{ windowId, focused: true }],
      hasWindow: id => id === windowId,
      relaunchScopeGeneration: () => 0,
      verifyRelaunch: () => verifyElectronRelaunch(artifact),
      requestRelaunch: restart => {
        const { args } = developerRelaunchOptions({ profile: "dev", pinned: true, config: null, restart }, artifact)
        // The old host shuts down before the successor reads its manifest.
        writeFileSync(manifest, JSON.stringify({ ...original, main: "b.js" }))
        const operand = packaged ? appPath : args![0]
        loadedEntry = operand === appPath || operand === artifact.appPath
          ? join(operand, JSON.parse(readFileSync(join(operand, "package.json"), "utf8")).main)
          : operand
      },
      schedule: callback => callback(),
    })

    const error = await mode.handleNativeRequest("developer.restartScope", restart).catch((error: Error) => error)
    assert.equal(loadedEntry, undefined, "shutdown must not load an entry from the changed manifest")
    assert.ok(error instanceof Error)
    assert.match(error.message, /Restart CodeNomad manually/)
    assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), original)
  })
}

test("a suffixless CLI operand resolves to its physical script without changing the app path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codenomad-extensionless-entry-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const main = join(root, "main.js")
  for (const name of ["main.js", "other.js"]) await writeFile(join(root, name), "")
  const manifest = join(root, "package.json")
  await writeFile(manifest, JSON.stringify({ main: "main.js" }))
  const entry = readElectronEntry([process.execPath, "--no-sandbox", join(root, "main")])!
  const resolved = resolveElectronMain(entry.path)
  assert.equal(resolved, await realpath(main))
  const artifact = pinElectronRelaunch(process.execPath, root, entry.args, resolved)
  const launch = { profile: "dev", pinned: true, config: null, restart: {
    runId: "old", windowId, restartId, nativeIdentity: developerNativeIdentity("dev", "config.yaml", undefined, artifact),
  } }
  await verifyElectronRelaunch(artifact)
  const { args } = developerRelaunchOptions(launch, artifact)
  await writeFile(manifest, JSON.stringify({ main: "other.js" }))
  assert.deepEqual(args?.slice(0, 2), ["--no-sandbox", resolved])
  assert.deepEqual(readDeveloperRelaunch(args!.slice(2)), launch)
  const successor = readElectronEntry([process.execPath, ...args!])!
  const successorMain = resolveElectronMain(successor.path)
  assert.equal(developerNativeIdentity("dev", "config.yaml", undefined,
    pinElectronRelaunch(process.execPath, dirname(successorMain), successor.args, successorMain)), launch.restart.nativeIdentity)
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
