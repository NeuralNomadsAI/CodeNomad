import assert from "node:assert/strict"
import test from "node:test"
import { MultiwindowLifecycle, type LifecycleWindow } from "./multiwindow-lifecycle"

const tick = () => new Promise((resolve) => setImmediate(resolve))
function windowRecord(id: string, calls: string[]): LifecycleWindow & { events: Map<string, Function> } {
  const events = new Map<string, Function>()
  const window = {
    on: (name: string, handler: Function) => events.set(name, handler), isDestroyed: () => false,
    isVisible: () => !calls.includes(`hide:${id}`) || calls.lastIndexOf(`show:${id}`) > calls.lastIndexOf(`hide:${id}`),
    hide: () => calls.push(`hide:${id}`), show: () => calls.push(`show:${id}`), close: () => { calls.push(`close:${id}`); events.get("close")?.({ preventDefault: () => assert.fail() }) },
    webContents: { isDestroyed: () => false, getURL: () => "http://localhost/app", executeJavaScript: async () => calls.push(`renderer:${id}`) },
  }
  return { id, window: window as never, tracker: { flush: async () => calls.push(`native:${id}`) } as never, events }
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
  assert.deepEqual(calls, ["prevent", "renderer:one", "native:one", "remove:one", "close:one"])
})

test("closing the sole local window while a remote remains removes its V3 record", async () => {
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
  assert.deepEqual(calls, ["prevent", "renderer:local", "native:local", "remove:local", "close:local"])
})

test("persisted local close waits for confirmed removal and remains retryable", async () => {
  const calls: string[] = []
  const first = windowRecord("one", calls)
  const second = windowRecord("two", calls)
  let removals = 0
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
  assert.equal(calls.filter((call) => call === "close:one").length, 1)
})

test("renderer persistence failure blocks destructive local close and remains retryable", async () => {
  const calls: string[] = []
  const first = windowRecord("one", calls)
  const second = windowRecord("two", calls)
  let attempts = 0
  first.window.webContents.executeJavaScript = async () => {
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
  assert.deepEqual(calls, ["prevent", "renderer:1"])
  first.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  await tick()
  assert.deepEqual(calls, ["prevent", "renderer:1", "prevent", "renderer:2", "native:one", "remove", "close:one"])
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
})

test("final close retains its record and shutdown stops/releases once", async () => {
  const calls: string[] = []
  const events = new Map<string, Function>()
  const first = windowRecord("one", calls)
  const app = { on: (name: string, handler: Function) => events.set(name, handler), quit: () => calls.push("quit"), exit: () => calls.push("exit") }
  const lifecycle = new MultiwindowLifecycle({
    app: app as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never, getLocalWindows: () => [first], getAllWindows: () => [first.window],
    removeWindowState: async () => { calls.push("remove"); return true }, getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.attach(first); lifecycle.registerAppEvents()
  first.events.get("close")?.({ preventDefault: () => calls.push("prevent") })
  assert.deepEqual(calls, ["prevent", "quit"])
  events.get("before-quit")?.({ preventDefault: () => calls.push("prevent-quit") })
  events.get("before-quit")?.({ preventDefault: () => calls.push("prevent-quit") })
  await tick(); await tick()
  assert.equal(calls.includes("remove"), false)
  assert.equal(calls.filter((call) => call === "stop").length, 1)
  assert.equal(calls.filter((call) => call === "release").length, 1)
})

test("Windows query preflush leaves the app alive until session end is confirmed", async () => {
  const calls: string[] = []
  const first = windowRecord("one", calls)
  const lifecycle = new MultiwindowLifecycle({
    app: { on: () => {}, quit: () => {}, exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [first], getAllWindows: () => [first.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true, isWindows: true, sessionEndCleanupTimeoutMs: 20,
  })
  lifecycle.attach(first)
  let vetoed = false
  first.events.get("query-session-end")?.({ preventDefault: () => { vetoed = true } })
  await (lifecycle as any).sessionEndPreparation
  assert.equal(vetoed, false)
  assert.deepEqual(calls, ["renderer:one", "native:one"])

  first.events.get("session-end")?.()
  await (lifecycle as any).sessionEnd
  assert.deepEqual(calls, ["renderer:one", "native:one", "aggregate", "stop", "release", "exit"])
})

test("remote windows receive session-end cleanup without local close semantics", async () => {
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
  first.window.webContents.executeJavaScript = async () => { calls.push("renderer"); throw new Error("snapshot too large") }
  const lifecycle = new MultiwindowLifecycle({
    app: { on: (name: string, handler: Function) => events.set(name, handler), quit: () => {}, exit: () => calls.push("exit") } as never,
    clientStateManager: { isPrimary: true, flush: async () => calls.push("aggregate"), drainAndReleasePrimary: async () => calls.push("release") } as never,
    cliManager: { shutdown: async () => calls.push("stop") } as never,
    getLocalWindows: () => [first], getAllWindows: () => [first.window], removeWindowState: async () => true,
    getAllowedRendererOrigins: () => ["http://localhost"], isTrustedRendererOrigin: () => true,
  })
  lifecycle.registerAppEvents()

  events.get("before-quit")?.({ preventDefault: () => calls.push("prevent") })
  await tick(); await tick()
  assert.deepEqual(calls, ["prevent", "hide:one", "renderer", "show:one"])
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
  lifecycle.attachRemote(remote.window); lifecycle.registerAppEvents()

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
  assert.deepEqual(calls, ["hide:one", "renderer:one", "native:one", "stop", "recover", "show:one"])

  events.get("before-quit")?.({ preventDefault: () => {} })
  await tick(); await tick()
  assert.equal(releases, 2)
  assert.equal(calls.filter((call) => call === "exit").length, 1)
  assert.deepEqual(calls, [
    "hide:one", "renderer:one", "native:one", "stop", "recover", "show:one",
    "hide:one", "renderer:one", "native:one", "stop", "exit",
  ])
})
