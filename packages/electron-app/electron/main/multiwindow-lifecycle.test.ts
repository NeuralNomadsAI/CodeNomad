import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ClientStateManager } from "./client-state"
import { CrossHostRegistration } from "./client-state-cross-host"
import { DeveloperMode } from "./developer-mode"
import { MultiwindowLifecycle, type LifecycleWindow } from "./multiwindow-lifecycle"
import { WindowStateTracker } from "./window-state"

const tick = () => new Promise((resolve) => setImmediate(resolve))
function windowRecord(id: string, calls: string[]): LifecycleWindow & { events: Map<string, Function> } {
  const events = new Map<string, Function>()
  const window = {
    on: (name: string, handler: Function) => events.set(name, handler), isDestroyed: () => false,
    isVisible: () => !calls.includes(`hide:${id}`) || calls.lastIndexOf(`show:${id}`) > calls.lastIndexOf(`hide:${id}`),
    hide: () => calls.push(`hide:${id}`), show: () => calls.push(`show:${id}`), close: () => { calls.push(`close:${id}`); events.get("close")?.({ preventDefault: () => assert.fail() }) },
    webContents: { isDestroyed: () => false, getURL: () => "http://localhost/app", executeJavaScript: async (source: string) => {
      if (source.includes('flush("release")')) calls.push(`workspace-release:${id}`)
      else if (!source.includes('flush("cancel")')) calls.push(`renderer:${id}`)
    } },
  }
  return { id, window: window as never, tracker: { flush: async () => calls.push(`native:${id}`), disarm() {} } as never, events }
}

test("closing one local window removes only its V3 record and leaves backend running", async () => {
  const calls: string[] = []
  const first = windowRecord("one", calls)
  const second = windowRecord("two", calls)
  const local = [first, second]
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => local, getAllWindows: () => local.map((record) => record.window),
    removeWindowState: async (id) => { calls.push(`remove:${id}`); return true }, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(first)
  first.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "renderer:one", "native:one", "remove:one", "workspace-release:one", "close:one"])
})

test("closing the last local window beside a remote window keeps its V3 record for the next local window", async () => {
  const calls: string[] = []
  const local = windowRecord("local", calls)
  const remote = { isDestroyed: () => false }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [local], getAllWindows: () => [local.window, remote as never],
    removeWindowState: async (id) => { calls.push(`remove:${id}`); return true }, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(local)
  local.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  // The remote window stays open; New Window, a later launch or the next start reopens this one.
  assert.deepEqual(calls, ["prevent", "renderer:local", "native:local", "workspace-release:local", "close:local"])
})

for (const failed of [false, true]) test(`quit joins an approved window's release before stopping its relay (failed=${failed})`, async () => {
  const calls: string[] = []
  const first = windowRecord("one", calls), second = windowRecord("two", calls)
  const local = [first, second]
  const appEvents = new Map<string, Function>()
  let started!: () => void, finish!: () => void
  let forgotten = false
  const releasing = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { finish = resolve })
  const execute = first.window.webContents.executeJavaScript
  first.window.webContents.executeJavaScript = async source => {
    if (source.includes('flush("release")')) {
      started()
      await held
    } else if (forgotten) throw new Error("Unknown client state window")
    return execute(source)
  }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: (name: string, handler: Function) => appEvents.set(name, handler), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true, flush: async () => {}, drainAndReleasePrimary: async () => {} } as never,
    cliManager: { shutdown: async () => { calls.push("stop"); if (failed) throw new Error("CLI failed") } } as never,
    getLocalWindows: () => local, getAllWindows: () => local.map(record => record.window),
    removeWindowState: async () => { forgotten = true; return true },
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(first)
  lifecycle.registerAppEvents()
  first.events.get("close")?.({ preventDefault() {} })
  await releasing
  appEvents.get("before-quit")?.({ preventDefault() {} })
  try {
    await tick()
    assert.ok(calls.includes("workspace-release:two"), "quit releases the remaining window concurrently")
    assert.ok(!calls.includes("stop"), "the relay is still up while the approved close is releasing")
    assert.equal(calls.filter(call => call === "renderer:one").length, 1, "quit does not capture the approved window again")
  } finally {
    finish()
  }
  await tick()
  assert.deepEqual(calls.filter(call => ["workspace-release:one", "stop", "exit"].includes(call)),
    failed ? ["workspace-release:one", "stop"] : ["workspace-release:one", "stop", "exit"])
  if (failed) {
    assert.ok(calls.includes("show:two"), "only the remaining window recovers after refused quit")
    assert.ok(!calls.includes("show:one"))
  }
})

for (const refused of [false, true]) test(`quit waits for a window removal on disk (refused=${refused})`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codenomad-close-"))
  let started!: () => void, finish!: () => void
  const writeStarted = new Promise<void>(resolve => { started = resolve })
  const finishWrite = new Promise<void>(resolve => { finish = resolve })
  const calls: string[] = []
  let removedId: string | undefined
  const state = new ClientStateManager(directory, async (path, contents) => {
    if (removedId && !JSON.parse(contents).windowOrder.includes(removedId)) {
      removedId = undefined
      started()
      await finishWrite
      if (refused) throw new Error("removal refused")
    }
    await writeFile(path, contents)
  }, { crossHostElectionDirectory: join(directory, "election") })
  t.mock.getter(CrossHostRegistration.prototype, "isPrimary", () => assert.fail("close or quit used synchronous lease verification"))
  t.after(async () => {
    await state.drainAndReleasePrimary()
    await rm(directory, { recursive: true, force: true })
  })
  const first = windowRecord(state.activeWindowId, calls), second = windowRecord((await state.addWindow())!, calls)
  const events = new EventEmitter()
  Object.assign(first.window, {
    on: events.on.bind(events),
    getPosition: () => [0, 0], getContentSize: () => [1200, 800],
    isMaximized: () => false, isFullScreen: () => false,
    close: () => {
      calls.push("closed")
      events.emit("close", { preventDefault: () => assert.fail("approved close was prevented") })
      events.emit("closed")
    },
  })
  Object.assign(first.window.webContents, { on: () => {}, getZoomFactor: () => 1 })
  const execute = first.window.webContents.executeJavaScript
  first.window.webContents.executeJavaScript = async source => {
    if (source.includes('flush("prepare")')) await state.saveClientState({ drafts: [] }, undefined, first.id)
    return execute(source)
  }
  first.tracker = new WindowStateTracker(first.window, state)
  const warn = t.mock.method(console, "warn", () => {})
  const app = new EventEmitter()
  const lifecycle = new MultiwindowLifecycle({
    app: Object.assign(app, { exit: () => calls.push("exit") }) as never,
    clientStateManager: state,
    cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [first, second], getAllWindows: () => [first.window, second.window],
    removeWindowState: id => { removedId = id; return state.removeWindow(id) },
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(first)
  lifecycle.registerAppEvents()
  events.emit("close", { preventDefault() {} })
  await writeStarted
  try {
    app.emit("before-quit", { preventDefault() {} })
    await tick()
  } finally {
    finish()
  }
  await (lifecycle as any).shutdown?.catch(() => {})
  await tick()
  assert.deepEqual(calls.filter(call => call === `renderer:${first.id}`), Array(refused ? 2 : 1).fill(`renderer:${first.id}`))
  assert.deepEqual(state.windowIds, refused ? [first.id, second.id] : [second.id])
  assert.ok(calls.includes("exit"), "quit completes rather than reopening the other window")
  assert.ok(!warn.mock.calls.some(({ arguments: args }) => args[0] === "[client-state] failed to save window state"),
    "the final close event does not save removed geometry")
})

test("closing a remote window awaits only that window's workspace release", async () => {
  const calls: string[] = []
  const local = windowRecord("local", calls), remote = windowRecord("remote", calls)
  let finish!: () => void
  remote.window.webContents.executeJavaScript = async source => {
    assert.match(source, /flush\("release"\)/)
    calls.push("remote release")
    await new Promise<void>(resolve => { finish = resolve })
  }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => assert.fail() } as never,
    clientStateManager: { isPrimary: false } as never, cliManager: {} as never,
    getLocalWindows: () => [local], getAllWindows: () => [local.window, remote.window],
    isRemoteWindow: window => window === remote.window,
    removeWindowState: async () => assert.fail(), getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach({ ...remote, tracker: null, persisted: false })
  remote.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "remote release"])
  remote.events.get("close")?.({ preventDefault: () => calls.push("prevent again") })
  assert.deepEqual(calls, ["prevent", "remote release", "prevent again"])
  finish()
  await tick()
  assert.deepEqual(calls, ["prevent", "remote release", "prevent again", "close:remote"])
})

test("a local window on the sign-in page closes without waiting for a renderer that is not there", async () => {
  const calls: string[] = []
  const stuck = windowRecord("stuck", calls)
  const other = windowRecord("other", calls)
  ;(stuck.window as unknown as { webContents: unknown }).webContents = {
    isDestroyed: () => false, getURL: () => "http://localhost/login",
    executeJavaScript: async () => { throw new Error("Renderer client-state flush callback is unavailable") },
  }
  const local = [stuck, other]
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => local, getAllWindows: () => local.map((record) => record.window),
    removeWindowState: async (id) => { calls.push(`remove:${id}`); return true }, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(stuck)
  stuck.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "native:stuck", "remove:stuck", "close:stuck"])
})

test("Preferences does not turn the final local close into a destructive window removal", async () => {
  const calls: string[] = []
  const local = windowRecord("local", calls)
  const preferences = { isDestroyed: () => false }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [local], getAllWindows: () => [local.window, preferences as never],
    isSupportWindow: (window) => window === preferences,
    removeWindowState: async (id) => { calls.push(`remove:${id}`); return true }, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(local)
  local.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "quit"])
})

test("Preferences does not keep the final support window alive", async () => {
  const calls: string[] = []
  const remote = windowRecord("remote", calls)
  const preferences = { isDestroyed: () => false }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [], getAllWindows: () => [remote.window, preferences as never],
    isSupportWindow: (window) => window === preferences,
    removeWindowState: async () => true, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attachSupportWindow(remote.window)
  remote.events.get("close")?.({ defaultPrevented: false, preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "quit"])
})

test("a hidden launch window never keeps the last visible local window from quitting", async () => {
  const calls: string[] = []
  const local = windowRecord("local", calls)
  const launch = { ...windowRecord("launch", calls), persisted: false }
  const loadingRemote = { isDestroyed: () => false }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [local, launch], getAllWindows: () => [local.window, launch.window, loadingRemote as never],
    isLaunchWindow: (window) => window === launch.window || window === (loadingRemote as never),
    removeWindowState: async (id) => { calls.push(`remove:${id}`); return true }, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(local)
  local.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "quit"], "the whole app quits and the window record is kept")
})

test("a hidden launch window never keeps the last remote window from quitting", async () => {
  const calls: string[] = []
  const remote = windowRecord("remote", calls)
  const launch = { isDestroyed: () => false }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [], getAllWindows: () => [remote.window, launch as never],
    isLaunchWindow: (window) => window === (launch as never),
    removeWindowState: async () => true, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attachSupportWindow(remote.window)
  remote.events.get("close")?.({ defaultPrevented: false, preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "quit"])
})

test("a launch window still on its loading page is disposed without a renderer flush", async () => {
  const calls: string[] = []
  const launch = { ...windowRecord("launch", calls), persisted: false, tracker: null }
  // A backend startup failure hands the connection off before the App installs its flush callback.
  launch.window.webContents.executeJavaScript = async () => { calls.push("renderer:launch"); throw new Error("Renderer client-state flush callback is unavailable") }
  const fallback = { isDestroyed: () => false }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [launch], getAllWindows: () => [launch.window, fallback as never],
    isLaunchWindow: (window) => window === launch.window,
    removeWindowState: async (id) => { calls.push(`remove:${id}`); return true }, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(launch)
  launch.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "close:launch"], "only the fallback window remains")
})

test("an ordinary unpersisted window still flushes its renderer before closing", async () => {
  const calls: string[] = []
  // It may hold user work: only launch-owned windows skip the persistence safeguard.
  const ephemeral = { ...windowRecord("ephemeral", calls), persisted: false }
  const launch = { isDestroyed: () => false }
  const remote = { isDestroyed: () => false }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [ephemeral], getAllWindows: () => [ephemeral.window, launch as never, remote as never],
    isLaunchWindow: (window) => window === (launch as never),
    removeWindowState: async (id) => { calls.push(`remove:${id}`); return true }, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(ephemeral)
  ephemeral.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "renderer:ephemeral", "native:ephemeral", "workspace-release:ephemeral", "close:ephemeral"])
})

test("closing every window quits, Remote Control included", () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const lifecycle = new MultiwindowLifecycle({
    app: { on: (name: string, handler: Function) => events.set(name, handler), quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [],
    getAllWindows: () => [],
    removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"],
    isTrustedRendererOrigin: () => true,
  })
  lifecycle.registerAppEvents()

  // The backend stops with the app; an enabled Remote Control resumes at the next launch.
  events.get("window-all-closed")?.()
  assert.deepEqual(calls, ["quit"])
})

test("simultaneous local closes retain one record for whole-app shutdown", async () => {
  const calls: string[] = []
  const first = windowRecord("one", calls)
  const second = windowRecord("two", calls)
  const local = [first, second]
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => local,
    getAllWindows: () => local.map((record) => record.window),
    removeWindowState: async (id) => { calls.push(`remove:${id}`); return true },
    getAllowedRendererOrigins: () => ["http://localhost"],
    isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(first)
  lifecycle.attach(second)

  first.events.get("close")?.({ preventDefault: () => calls.push("prevent:one") })
  second.events.get("close")?.({ preventDefault: () => calls.push("prevent:two") })
  await tick()
  await tick()

  assert(calls.includes("quit"))
  assert.equal(calls.includes("remove:two"), false)
})

test("persisted local close waits for confirmed removal and remains retryable", async () => {
  const calls: string[] = []
  const first = windowRecord("one", calls)
  const second = windowRecord("two", calls)
  let removals = 0
  first.window.webContents.executeJavaScript = async source => {
    if (source.includes('flush("release")')) calls.push("release-workspaces")
  }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [first, second], getAllWindows: () => [first.window, second.window],
    removeWindowState: async () => {
      removals += 1
      calls.push(`remove:${removals}`)
      if (removals === 2) throw new Error("remove failed")
      return removals === 3
    },
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(first)

  first.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.equal(calls.includes("close:one"), false)
  first.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.equal(calls.includes("close:one"), false)
  first.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()

  assert.equal(removals, 3)
  assert.equal(calls.filter(call => call === "release-workspaces").length, 1)
  assert.ok(calls.indexOf("release-workspaces") > calls.indexOf("remove:3"))
  assert.equal(calls.filter((call) => call === "close:one").length, 1)
})

test("renderer persistence failure blocks destructive local close and remains retryable", async () => {
  const calls: string[] = []
  const first = windowRecord("one", calls)
  const second = windowRecord("two", calls)
  let attempts = 0
  first.window.webContents.executeJavaScript = async source => {
    if (source.includes('flush("cancel")')) { calls.push("resume"); return }
    if (source.includes('flush("release")')) { calls.push("workspace-release"); return }
    attempts += 1
    calls.push(`renderer:${attempts}`)
    if (attempts === 1) throw new Error("snapshot too large")
  }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => {}, exit: () => {} } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: { shutdown: async () => {} } as never,
    getLocalWindows: () => [first, second], getAllWindows: () => [first.window, second.window],
    removeWindowState: async () => { calls.push("remove"); return true },
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(first)

  first.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "renderer:1", "resume"])
  first.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "renderer:1", "resume", "prevent", "renderer:2", "native:one", "remove", "workspace-release", "close:one"])
})

test("quitting with a hidden launch window pending flushes and exits without asking its renderer", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const local = windowRecord("local", calls)
  const launch = { ...windowRecord("launch", calls), persisted: false }
  // Its connection is still pending: asking its renderer would fail or hang the whole shutdown.
  launch.window.webContents.executeJavaScript = async () => { throw new Error("Script failed to execute") }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: (name: string, handler: Function) => events.set(name, handler), quit: () => {}, exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never, getLocalWindows: () => [local, launch], getAllWindows: () => [local.window, launch.window],
    isLaunchWindow: (window) => window === launch.window,
    removeWindowState: async () => true, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.registerAppEvents()
  events.get("before-quit")?.({ preventDefault: () => {} })
  for (let index = 0; index < 5; index++) await tick()
  assert.deepEqual(calls.filter((call) => !call.startsWith("hide:")), ["renderer:local", "native:local", "aggregate", "workspace-release:local", "stop", "release", "exit"])
})

test("global shutdown asks all renderers concurrently before aggregate persistence", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const first = windowRecord("one", calls)
  const second = windowRecord("two", calls)
  first.window.webContents.executeJavaScript = async () => { calls.push("renderer:one"); await gate }
  second.window.webContents.executeJavaScript = async () => { calls.push("renderer:two") }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: (name: string, handler: Function) => events.set(name, handler), quit: () => {}, exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never, getLocalWindows: () => [first, second], getAllWindows: () => [first.window, second.window],
    flushSupportWindows: async () => { await gate; calls.push("native:preferences") },
    removeWindowState: async () => true, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.registerAppEvents()
  events.get("before-quit")?.({ preventDefault: () => {} })
  await tick()
  assert.deepEqual(calls.filter((call) => call.startsWith("renderer:")), ["renderer:one", "renderer:two"])
  assert.equal(calls.includes("aggregate"), false)
  release()
  await tick(); await tick()
  assert.ok(calls.indexOf("aggregate") > calls.indexOf("native:two"))
  assert.ok(calls.indexOf("native:preferences") >= 0)
  assert.ok(calls.indexOf("release") > calls.indexOf("native:preferences"))
})

test("quit commits a slow snapshot before attempting release, then ignores an expired release", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const record = windowRecord("one", calls)
  record.window.webContents.executeJavaScript = async source => {
    if (source.includes('flush("prepare")')) {
      await new Promise(resolve => setTimeout(resolve, 1_100))
      calls.push("snapshot")
    } else if (source.includes('flush("release")')) {
      calls.push("release attempted")
      await new Promise(() => {})
    }
  }
  let resolve!: () => void
  const exit = new Promise<void>(done => { resolve = done })
  const lifecycle = new MultiwindowLifecycle({
    app: { on: (name: string, handler: Function) => events.set(name, handler), exit: resolve } as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => {} } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [record], getAllWindows: () => [record.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.registerAppEvents()
  events.get("before-quit")?.({ preventDefault: () => {} })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([exit, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("quit did not finish")), 4_000) })])
  } finally { clearTimeout(deadline) }
  assert.deepEqual(calls, ["hide:one", "snapshot", "native:one", "aggregate", "release attempted", "stop"])
})

test("final close retains its record and shutdown stops/releases once", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const first = windowRecord("one", calls)
  const app = { on: (name: string, handler: Function) => events.set(name, handler), quit: () => calls.push("quit"), exit: () => calls.push("exit") }
  let stopSpeech!: () => void
  const speech = new Promise<void>(resolve => { stopSpeech = resolve })
  const lifecycle = new MultiwindowLifecycle({
    app: app as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never, getLocalWindows: () => [first], getAllWindows: () => [first.window],
    stopSpeech: () => { calls.push("speech"); return speech },
    removeWindowState: async () => { calls.push("remove"); return true }, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(first); lifecycle.registerAppEvents()
  first.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "quit"])
  events.get("before-quit")?.({ preventDefault: () => calls.push("prevent-quit") })
  events.get("before-quit")?.({ preventDefault: () => calls.push("prevent-quit") })
  await tick()
  assert.equal(calls.filter((call) => call === "speech").length, 1)
  assert.equal(calls.includes("exit"), false)
  stopSpeech()
  await tick(); await tick()
  assert.equal(calls.includes("remove"), false)
  assert.equal(calls.filter((call) => call === "stop").length, 1)
  assert.equal(calls.filter((call) => call === "release").length, 1)
})

test("Windows query preflush leaves the app alive until session end is confirmed", async () => {
  const calls: string[] = []
  const first = windowRecord("one", calls)
  first.window.webContents.executeJavaScript = async source => {
    calls.push(source.includes('flush("release")') ? "renderer:release" : "renderer:one")
  }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit"), exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [first], getAllWindows: () => [first.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true, isWindows: true, sessionEndCleanupTimeoutMs: 20,
  })
  lifecycle.attach(first)
  assert.equal(lifecycle.relaunchScopeGeneration(), 0)
  let vetoed = false
  first.events.get("query-session-end")?.({ preventDefault: () => { vetoed = true } })
  assert.equal(lifecycle.relaunchScopeGeneration(), undefined)
  await (lifecycle as any).sessionEndPreparation
  assert.equal(vetoed, false)
  assert.equal(lifecycle.relaunchScopeGeneration(), undefined)
  lifecycle.requestRelaunch({ args: ["--codenomad-automation-relaunch=fixture"] })
  assert.deepEqual(calls, ["renderer:one", "native:one"])

  first.events.get("session-end")?.()
  await (lifecycle as any).sessionEnd
  assert.deepEqual(calls, ["renderer:one", "native:one", "renderer:one", "native:one", "aggregate", "renderer:release", "stop", "release", "exit"])
})

test("Windows query and cancellation revoke an unarmed native restart without blocking a new one", async () => {
  const calls: string[] = []
  const first = windowRecord("one", calls)
  let endSessionMessage: ((wParam: Buffer) => void) | undefined
  first.window.hookWindowMessage = (message, handler) => {
    assert.equal(message, 0x0016)
    endSessionMessage = wParam => handler(wParam, Buffer.alloc(8))
  }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => calls.push("quit") } as never,
    clientStateManager: { isPrimary: true } as never, cliManager: {} as never,
    getLocalWindows: () => [first], getAllWindows: () => [first.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true, isWindows: true,
  })
  lifecycle.attach(first)
  const target = { nativeIdentity: "electron:test", runId: "run", windowId: "one", windowInstance: "instance" }
  const scheduled: Array<() => void> = []
  const mode = new DeveloperMode({
    ...target, devtoolsDataPath: ".", windows: () => [{ ...target, focused: true }], hasWindow: () => true,
    relaunchScopeGeneration: () => lifecycle.relaunchScopeGeneration(),
    requestRelaunch: restart => lifecycle.requestRelaunch({ args: [restart.restartId] }),
    schedule: callback => scheduled.push(callback),
  })
  const admit = (restartId: string) => mode.handleNativeRequest("developer.restartScope", { ...target, restartId })
  const old = "8d80a777-0085-48c8-b791-d3514bd63f32", fresh = "7c3e5066-017d-4ce1-a371-187ac459c4b2"
  await admit(old)
  first.events.get("query-session-end")?.()
  await (lifecycle as any).sessionEndPreparation
  await assert.rejects(admit(fresh), /shutting down/)
  assert.ok(endSessionMessage)
  endSessionMessage(Buffer.alloc(8))
  await admit(fresh)
  scheduled[0]()
  assert.equal(calls.includes("quit"), false)
  await assert.rejects(admit(old), /already pending/)
  scheduled[1]()
  assert.equal(calls.filter(call => call === "quit").length, 1)
})

for (const outcome of ["normal", "query", "before deadline", "late success", "late failure"] as const) {
  test(`scoped relaunch on Windows: ${outcome}`, { timeout: 2_000 }, async () => {
    const calls: string[] = []
    const events = new Map<string, Function>()
    const local = windowRecord("one", calls)
    let finishStop!: () => void
    let failStop!: (error: Error) => void
    let exit!: () => void
    const stop = new Promise<void>((resolve, reject) => { finishStop = resolve; failStop = reject })
    const exited = new Promise<void>((resolve) => { exit = resolve })
    const lifecycle = new MultiwindowLifecycle({
      app: {
        on: (name: string, handler: Function) => events.set(name, handler),
        quit: () => events.get("before-quit")?.({ preventDefault: () => {} }),
        relaunch: () => calls.push("relaunch"),
        exit: () => { calls.push("exit"); exit() },
      } as never,
      clientStateManager: { isPrimary: true, flush: async () => {}, drainAndReleasePrimary: async () => calls.push("release") } as never,
      cliManager: { shutdown: () => { calls.push("stop"); return stop } } as never,
      getLocalWindows: () => [local], getAllWindows: () => [local.window], removeWindowState: async () => true,
      getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
      isWindows: true, sessionEndCleanupTimeoutMs: outcome === "before deadline" ? 50 : 5,
    })
    lifecycle.attach(local)
    lifecycle.registerAppEvents()
    lifecycle.requestRelaunch({ args: ["--codenomad-automation-relaunch=fixture"] })
    await tick()
    assert.equal(calls.at(-1), "stop")

    if (outcome === "query") {
      local.events.get("query-session-end")!()
    } else if (outcome !== "normal") {
      local.events.get("session-end")!()
      if (outcome !== "before deadline") {
        await exited
        assert.equal(calls.includes("release"), false)
      }
    }
    if (outcome === "late failure") failStop(new Error("late CLI failure"))
    else finishStop()
    await exited
    await tick()
    const afterStop = {
      normal: ["release", "relaunch", "exit"],
      query: ["release", "exit"],
      "before deadline": ["release", "exit"],
      "late success": ["exit", "release"],
      "late failure": ["exit"],
    }[outcome]
    assert.deepEqual(calls.slice(calls.indexOf("stop") + 1), afterStop)
  })
}

test("support windows receive session-end cleanup without local close semantics", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const remote = { on: (name: string, handler: Function) => events.set(name, handler), isDestroyed: () => false }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [], getAllWindows: () => [remote as never], removeWindowState: async () => { calls.push("remove"); return true },
    getAllowedRendererOrigins: () => [], isTrustedRendererOrigin: () => false, isWindows: true,
  })

  lifecycle.attachSessionEnd(remote as never)
  let vetoed = false
  events.get("query-session-end")?.({ preventDefault: () => { vetoed = true } })
  await (lifecycle as any).sessionEndPreparation
  assert.equal(vetoed, false)
  assert.deepEqual(calls, [])
  events.get("session-end")?.()
  await (lifecycle as any).sessionEnd
  assert.deepEqual(calls, ["aggregate", "stop", "release", "exit"])
})

test("normal quit reports a failed CLI shutdown without allowing exit", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const first = windowRecord("one", calls)
  const execute = first.window.webContents.executeJavaScript
  first.window.webContents.executeJavaScript = (source, userGesture) => {
    if (source.includes('flush("cancel")')) calls.push("cancel")
    return execute(source, userGesture)
  }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: (name: string, handler: Function) => events.set(name, handler), quit: () => {}, exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true, flush: async () => {}, drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => { throw new Error("CLI failed") } } as never,
    getLocalWindows: () => [first], getAllWindows: () => [first.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.registerAppEvents()
  events.get("before-quit")?.({ preventDefault: () => calls.push("prevent") })
  await tick(); await tick()
  assert.equal(calls.includes("prevent"), true)
  assert.equal(calls.includes("exit"), false)
  assert.equal(calls.includes("release"), false)
  assert.ok(calls.indexOf("renderer:one") < calls.indexOf("workspace-release:one"))
  assert.ok(calls.indexOf("workspace-release:one") < calls.indexOf("cancel"), "a refused quit cancels the renderer's release")
  assert.ok(calls.indexOf("show:one") > calls.indexOf("hide:one"))
})

test("failed restart does not relaunch during a later ordinary quit", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const first = windowRecord("one", calls)
  let attempts = 0
  const app = {
    on: (name: string, handler: Function) => events.set(name, handler),
    quit: () => events.get("before-quit")?.({ preventDefault: () => calls.push("prevent") }),
    relaunch: () => calls.push("relaunch"),
    exit: () => calls.push("exit"),
  }
  const lifecycle = new MultiwindowLifecycle({
    app: app as never,
    clientStateManager: { isPrimary: true, flush: async () => {}, drainAndReleasePrimary: async () => {} } as never,
    cliManager: { shutdown: async () => { attempts += 1; if (attempts === 1) throw new Error("CLI failed") } } as never,
    getLocalWindows: () => [first], getAllWindows: () => [first.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.registerAppEvents()

  lifecycle.requestRelaunch()
  await tick(); await tick()
  app.quit()
  await tick(); await tick()

  assert.equal(calls.includes("relaunch"), false)
  assert.equal(calls.filter((call) => call === "exit").length, 1)
})

test("normal quit restores windows when renderer persistence fails", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const first = windowRecord("one", calls)
  const hidden = windowRecord("hidden", calls)
  hidden.window.isVisible = () => false
  hidden.window.webContents.executeJavaScript = async source => {
    calls.push(source.includes('flush("cancel")') ? "resume:hidden" : "renderer:hidden")
  }
  first.window.webContents.executeJavaScript = async source => {
    if (source.includes('flush("cancel")')) { calls.push("resume"); return }
    calls.push("renderer")
    throw new Error("snapshot too large")
  }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: (name: string, handler: Function) => events.set(name, handler), quit: () => {}, exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [first, hidden], getAllWindows: () => [first.window, hidden.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.registerAppEvents()

  events.get("before-quit")?.({ preventDefault: () => calls.push("prevent") })
  await tick(); await tick()
  assert.deepEqual(calls, ["prevent", "hide:one", "renderer", "renderer:hidden", "native:hidden", "resume", "show:one", "resume:hidden"])
})

test("final close restores its window after failed shutdown and allows one deduped retry", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const first = windowRecord("one", calls)
  let attempts = 0
  let rejectFirst!: (error: Error) => void
  let resolveSecond!: () => void
  const firstAttempt = new Promise<void>((_resolve, reject) => { rejectFirst = reject })
  const secondAttempt = new Promise<void>((resolve) => { resolveSecond = resolve })
  const app = {
    on: (name: string, handler: Function) => events.set(name, handler),
    quit: () => {
      calls.push(`quit-visible:${first.window.isVisible()}`)
      events.get("before-quit")?.({ preventDefault: () => calls.push("prevent-quit") })
    },
    exit: () => calls.push("exit"),
  }
  const lifecycle = new MultiwindowLifecycle({
    app: app as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: () => { attempts += 1; calls.push(`stop:${attempts}`); return attempts === 1 ? firstAttempt : secondAttempt } } as never,
    getLocalWindows: () => [first], getAllWindows: () => [first.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(first); lifecycle.registerAppEvents()

  first.events.get("close")?.({ preventDefault: () => calls.push("prevent-close") })
  first.events.get("close")?.({ preventDefault: () => calls.push("prevent-close") })
  await tick()
  assert.equal(attempts, 1)
  assert.equal(calls.filter((call) => call === "quit-visible:true").length, 1)
  rejectFirst(new Error("CLI failed"))
  await tick()
  assert.ok(calls.indexOf("show:one") > calls.indexOf("hide:one"))

  first.events.get("close")?.({ preventDefault: () => calls.push("prevent-close") })
  first.events.get("close")?.({ preventDefault: () => calls.push("prevent-close") })
  await tick()
  assert.equal(attempts, 2)
  assert.equal(calls.filter((call) => call === "hide:one").length, 2)
  resolveSecond()
  await tick(); await tick()
  assert.equal(calls.filter((call) => call === "release").length, 1)
  assert.equal(calls.filter((call) => call === "exit").length, 1)
})

test("final remote close stays restorable by routing through app shutdown", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const remote = windowRecord("remote", calls)
  const app = {
    on: (name: string, handler: Function) => events.set(name, handler),
    quit: () => { calls.push("quit"); events.get("before-quit")?.({ preventDefault: () => calls.push("prevent-quit") }) },
    exit: () => calls.push("exit"),
  }
  const lifecycle = new MultiwindowLifecycle({
    app: app as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => { calls.push("stop"); throw new Error("CLI failed") } } as never,
    getLocalWindows: () => [], getAllWindows: () => [remote.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => [], isTrustedRendererOrigin: () => false,
  })
  lifecycle.attachSupportWindow(remote.window); lifecycle.registerAppEvents()

  remote.events.get("close")?.({ preventDefault: () => calls.push("prevent-close") })
  await tick(); await tick()
  assert.deepEqual(calls, ["prevent-close", "quit", "prevent-quit", "hide:remote", "aggregate", "stop", "show:remote"])
})

test("failed primary release is retried by the next shutdown attempt", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const first = windowRecord("one", calls)
  let releases = 0
  const lifecycle = new MultiwindowLifecycle({
    app: { on: (name: string, handler: Function) => events.set(name, handler), quit: () => {}, exit: () => calls.push("exit") } as never,
    clientStateManager: {
      isPrimary: true,
      flush: async () => {},
      drainAndReleasePrimary: async () => {
        releases += 1
        if (releases === 1) throw new Error("release failed")
      },
    } as never,
    cliManager: {
      shutdown: async () => { calls.push("stop") },
      recoverAfterFailedShutdown: async () => { calls.push("recover") },
    } as never,
    getLocalWindows: () => [first], getAllWindows: () => [first.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.registerAppEvents()

  events.get("before-quit")?.({ preventDefault: () => {} })
  await tick(); await tick()
  assert.equal(releases, 1)
  assert.equal(calls.includes("exit"), false)
  assert.deepEqual(calls, ["hide:one", "renderer:one", "native:one", "workspace-release:one", "stop", "recover", "show:one"])

  events.get("before-quit")?.({ preventDefault: () => {} })
  await tick(); await tick()
  assert.equal(releases, 2)
  assert.equal(calls.filter((call) => call === "exit").length, 1)
  assert.deepEqual(calls, [
    "hide:one", "renderer:one", "native:one", "workspace-release:one", "stop", "recover", "show:one",
    "hide:one", "renderer:one", "native:one", "workspace-release:one", "stop", "exit",
  ])
})
