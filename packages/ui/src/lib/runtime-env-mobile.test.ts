import assert from "node:assert/strict"
import { test } from "node:test"

test("hosted mobile overrides fence native APIs even with Tauri globals and user agent", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const commands: string[] = []
  const invoke = async (command: string) => {
    commands.push(command)
    throw new Error(`Hosted UI must not invoke ${command}`)
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __CODENOMAD_RUNTIME_HOST__: "web",
    __CODENOMAD_WINDOW_CONTEXT__: "remote",
    __TAURI__: { core: { invoke } },
    __TAURI_INTERNALS__: { invoke },
  } })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    userAgent: "Mozilla/5.0 (Linux; Android 15; Mobile) Tauri/2.0",
    userAgentData: { mobile: true },
  } })
  try {
    // Import after initialization: consumers use both the cached snapshot and
    // live capability predicates. Neither may infer native authority from IPC.
    const runtime = await import("./runtime-env")
    assert.deepEqual(runtime.runtimeEnv, { host: "web", platform: "mobile", windowContext: "remote" })
    assert.equal(runtime.detectRuntimeEnvironment(), runtime.runtimeEnv)
    assert.equal(runtime.isWebHost(), true)
    assert.equal(runtime.isRemoteWindow(), true)
    assert.equal(runtime.isMobilePlatform(), true)
    assert.equal(runtime.usesClientState(), true, "Hosted client state is not native authority")
    for (const capability of [runtime.isElectronHost, runtime.isTauriHost, runtime.isDesktopHost,
      runtime.isLocalTauriHost, runtime.isLocalWindow, runtime.isNativeApplicationWindow,
      runtime.canUseNativeDialogs, runtime.canOpenRemoteWindows, runtime.canRestartCli,
      runtime.canUseDesktopFolderDrop]) {
      assert.equal(capability(), false)
    }

    const dialogs = await import("./native/native-functions")
    assert.equal(dialogs.supportsNativeDialogs(), false)
    assert.equal(dialogs.supportsNativeDialogsInCurrentWindow(), false)
    assert.equal(await dialogs.openNativeFolderDialog(), null)
    assert.equal(await dialogs.openNativeFileDialog(), null)
    assert.deepEqual(await dialogs.openNativeFileDialogs(), [])
    const cli = await import("./native/cli")
    assert.equal(await cli.restartCli(), false)
    const windowControls = await import("./native/window-controls")
    for (const action of ["minimize", "maximize", "close"] as const) await windowControls.runNativeWindowAction(action)
    await windowControls.startNativeWindowDrag()
    const wakeLock = await import("./native/wake-lock")
    assert.equal(await wakeLock.setWakeLockDesired(true), false)
    await wakeLock.setWakeLockDesired(false)
    const clientState = await import("./native/client-state")
    assert.deepEqual(await clientState.loadNativeClientState(), { isPrimary: false, restoreEnabled: false, snapshot: null })
    assert.equal(await clientState.saveNativeClientState({ draft: "local only" }), false)
    assert.equal(await clientState.clearNativeClientState(), false)
    assert.equal(await clientState.loadNativeClientStatePartition("fixture"), null)
    assert.deepEqual(commands, [], "No native calls, including swallowed errors, are allowed")
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
})
