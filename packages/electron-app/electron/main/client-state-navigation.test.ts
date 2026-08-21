import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ClientStateManager } from "./client-state"
import { ClientStateNavigationController, shouldResetRendererAccessTokenForNavigation } from "./client-state-navigation"
import { SerializedLifecycle } from "./serialized-lifecycle"

const tick = () => new Promise((resolve) => setImmediate(resolve))
function window(executeJavaScript: () => Promise<unknown> = async () => {}) {
  return { isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: () => "http://127.0.0.1:3000/app", executeJavaScript } }
}
function controller(win: ReturnType<typeof window>, manager: { isPrimary: boolean }, report: (error: unknown) => void = (error) => assert.fail(String(error)), lifecycle?: SerializedLifecycle) {
  return new ClientStateNavigationController(win as never, { clientStateManager: manager, isTrustedOrigin: () => true, reportFlushError: report, lifecycle })
}
function managerHarness(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-navigation-"))
  const manager = new ClientStateManager(directory, undefined, { crossHostElectionDirectory: join(directory, "election") })
  t.after(async () => { await manager.drainAndReleasePrimary().catch(() => {}); rmSync(directory, { recursive: true, force: true }) })
  return manager
}

test("renderer access resets only for trusted full main-frame navigation", () => {
  const trusted = (url: string) => new URL(url).origin === "http://127.0.0.1:3000"
  for (const [url, inPlace, mainFrame, expected] of [
    ["http://127.0.0.1:3000/reload", false, true, true],
    ["http://127.0.0.1:3000/frame", false, false, false],
    ["http://127.0.0.1:3000/#route", true, true, false],
    ["https://untrusted.example/reload", false, true, false],
  ] as const) assert.equal(shouldResetRendererAccessTokenForNavigation(url, inPlace, mainFrame, trusted), expected)
})

test("immediate reload flushes latest state before rotating document access", async (t) => {
  const manager = managerHarness(t)
  await manager.setRestoreEnabled(true)
  manager.claimClientStateAccess("outgoing")
  const load = (token: string) => { manager.assertRendererAccessToken(token); return manager.loadClientState() }
  const save = (token: string, state: unknown) => { manager.assertRendererAccessToken(token); return manager.saveClientState(state) }
  for (const denied of [() => load("other"), () => save("other", {})]) assert.throws(denied, /has not been claimed/)
  let navigated = false
  await controller(window(() => save("outgoing", { revision: 7, editor: "latest" })), manager).navigate(() => {
    navigated = true
    assert.deepEqual(load("outgoing").snapshot, { revision: 7, editor: "latest" })
    manager.resetRendererAccessToken()
  })
  assert.equal(navigated, true)
  assert.throws(() => load("outgoing"), /has not been claimed/)
  manager.claimClientStateAccess("incoming")
  assert.deepEqual(load("incoming").snapshot, { revision: 7, editor: "latest" })
})

test("failed navigation retains current document access", async (t) => {
  for (const [name, operation] of [
    ["loadURL", () => Promise.reject(new Error("loadURL failed"))],
    ["reload", () => { throw new Error("reload failed") }],
  ] as const) await t.test(name, async (st) => {
    const manager = managerHarness(st)
    manager.claimClientStateAccess("current")
    await assert.rejects(controller(window(), manager).navigate(operation), new RegExp(`${name} failed`))
    manager.assertRendererAccessToken("current")
    assert.equal(await manager.saveClientState({ retained: name }), true)
  })
})

test("hung renderer flush is bounded without rotating access or blocking navigation", async () => {
  const manager = { isPrimary: true, resets: 0, resetRendererAccessToken() { this.resets++ } }
  let navigated = false, reported = false
  const started = Date.now()
  await controller(window(() => new Promise(() => {})), manager, () => { reported = true }).navigate(() => { navigated = true })
  const elapsed = Date.now() - started
  assert.equal(reported, true)
  assert.equal(manager.resets, 0)
  assert.equal(navigated, true)
  assert.ok(elapsed >= 900 && elapsed < 2_000, `unexpected timeout: ${elapsed}ms`)
})

test("queued navigation preserves order and distinct generations", async () => {
  const calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const navigation = controller(window(), { isPrimary: true })
  const first = navigation.navigate(async (_window, generation) => { calls.push(`start-${generation}`); await gate; calls.push(`end-${generation}`) })
  const second = navigation.navigate((_window, generation) => { calls.push(`run-${generation}`) })
  await tick()
  assert.deepEqual(calls, ["start-1"])
  release()
  await Promise.all([first, second])
  assert.deepEqual(calls, ["start-1", "end-1", "run-2"])
})

test("queued navigation exposes whether work was invalidated before it mutates navigation state", async () => {
  const calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const navigation = controller(window(), { isPrimary: true })
  const first = navigation.navigate(async (_window, generation) => {
    await gate
    if (navigation.isCurrent(generation)) calls.push("stale")
  })
  const second = navigation.navigate((_window, generation) => {
    if (navigation.isCurrent(generation)) calls.push("current")
  })
  release()
  await Promise.all([first, second])
  assert.deepEqual(calls, ["current"])
})

test("shutdown authority cancels navigation dispatch after an in-flight renderer flush", async () => {
  const calls: string[] = []
  let flushStarted!: () => void, releaseFlush!: () => void
  const started = new Promise<void>((resolve) => { flushStarted = resolve })
  const gate = new Promise<void>((resolve) => { releaseFlush = resolve })
  const lifecycle = new SerializedLifecycle()
  const navigation = controller(window(async () => { calls.push("navigation-flush"); flushStarted(); await gate }), { isPrimary: true }, undefined, lifecycle)
  const pending = navigation.navigate(() => { calls.push("reload") })
  await started

  const shutdown = lifecycle.stop(async () => { calls.push("shutdown-flush") })
  releaseFlush()
  await Promise.all([pending, shutdown])

  assert.deepEqual(calls, ["navigation-flush", "shutdown-flush"])
})

test("shutdown skips renderer flushes for navigation still queued", async () => {
  const calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const lifecycle = new SerializedLifecycle()
  const navigation = controller(window(async () => { calls.push("flush") }), { isPrimary: true }, undefined, lifecycle)
  const first = lifecycle.enqueue(() => gate)
  const pending = navigation.navigate(() => { calls.push("reload") })
  const shutdown = lifecycle.stop(async () => { calls.push("shutdown") })

  release()
  await Promise.all([first, pending, shutdown])

  assert.deepEqual(calls, ["shutdown"])
})
