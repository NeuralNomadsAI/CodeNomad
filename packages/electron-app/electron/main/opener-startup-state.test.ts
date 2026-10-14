import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"
import type { BrowserWindow } from "electron"
import { forwardOpenerStartupState, runStartupStateCommandInWindow, type StartupStateCommand } from "./opener-startup-state"
import { PreferencesWindowRegistry } from "./preferences-window"
import type { RendererFlushWindow } from "./renderer-client-state-flush"

function renderer(id: string, url = "http://127.0.0.1:3000/app", callback: ((command: unknown) => unknown) | undefined = undefined) {
  const commands: unknown[] = []
  const handler = callback ?? ((command: unknown) => {
    commands.push(command)
    return Promise.resolve({ isPrimary: true, restoreEnabled: command !== "disable-restore" })
  })
  const page = { location: { origin: new URL(url).origin }, __CODENOMAD_STARTUP_STATE_COMMAND__: handler }
  let destroyed = false
  const window: RendererFlushWindow = {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => destroyed,
      getURL: () => url,
      executeJavaScript: async (source: string) => vm.runInNewContext(source, { window: page, URL }),
    },
  }
  return { id, window, page, commands, destroy: () => { destroyed = true } }
}

function fakePreferencesWindow() {
  return {
    webContents: { isDestroyed: () => false, on: () => undefined, send: () => undefined },
    isDestroyed: () => false, isMinimized: () => false, restore() {}, show() {}, focus() {}, on: () => undefined,
  } as unknown as BrowserWindow
}

test("startup commands run only through the exact opener renderer callback", async () => {
  const a = renderer("window-a")
  const trusted = (url: string) => url.startsWith("http://127.0.0.1:3000/")
  assert.deepEqual(await runStartupStateCommandInWindow(a.window, "disable-restore", trusted), { isPrimary: true, restoreEnabled: false })
  assert.deepEqual(a.commands, ["disable-restore"])

  const untrusted = renderer("remote", "https://outside.example/app")
  assert.equal(await runStartupStateCommandInWindow(untrusted.window, "clear", trusted), null)
  assert.deepEqual(untrusted.commands, [])

  const loading = renderer("loading")
  delete (loading.page as Record<string, unknown>).__CODENOMAD_STARTUP_STATE_COMMAND__
  assert.equal(await runStartupStateCommandInWindow(loading.window, "read", trusted), null)
  a.destroy()
  assert.equal(await runStartupStateCommandInWindow(a.window, "read", trusted), null)
  assert.equal(await runStartupStateCommandInWindow(undefined, "read", trusted), null)

  const forged = renderer("forged", undefined, () => ({ isPrimary: "yes" }))
  await assert.rejects(runStartupStateCommandInWindow(forged.window, "read", trusted), /Invalid startup state/)
  const hung = renderer("hung", undefined, () => new Promise(() => {}))
  await assert.rejects(runStartupStateCommandInWindow(hung.window, "read", trusted, 10), /timed out after 10ms/)
})

test("Preferences follows the latest opener and fences stale or orphaned mutations", async () => {
  const registry = new PreferencesWindowRegistry()
  const preferences = fakePreferencesWindow()
  const windows = new Map([["window-a", renderer("window-a")], ["window-b", renderer("window-b")]])
  const trusted = () => true
  const run = (openerId: string, command: StartupStateCommand) => runStartupStateCommandInWindow(windows.get(openerId)?.window, command, trusted)
  const forward = (command: StartupStateCommand, epoch?: number) => forwardOpenerStartupState(registry.opener(preferences)!, command, epoch, run)

  registry.register(preferences, { section: "general" }, "window-a")
  const first = await forward("read")
  assert.deepEqual(first, { epoch: first.epoch, state: { isPrimary: true, restoreEnabled: true }, applied: false })
  assert.deepEqual(await forward("disable-restore", first.epoch), { epoch: first.epoch, state: { isPrimary: true, restoreEnabled: false }, applied: true })

  // Re-opening from the same window keeps the epoch; another window rotates it.
  registry.reuse({ section: "general" }, "window-a")
  assert.equal(registry.opener(preferences)!.epoch, first.epoch)
  registry.reuse({ section: "general" }, "window-b")
  const second = registry.opener(preferences)!
  assert.equal(second.id, "window-b")
  assert.ok(second.epoch > first.epoch)

  // A change prepared against A is never applied to B.
  assert.deepEqual(await forward("clear", first.epoch), { epoch: second.epoch, state: { isPrimary: true, restoreEnabled: true }, applied: false })
  assert.deepEqual(await forward("clear"), { epoch: second.epoch, state: { isPrimary: true, restoreEnabled: true }, applied: false })
  assert.deepEqual(windows.get("window-a")!.commands, ["read", "disable-restore"])
  assert.deepEqual(windows.get("window-b")!.commands, ["read", "read"])

  // The closed opener stays the target: no fallback to another window.
  windows.get("window-b")!.destroy()
  assert.deepEqual(await forward("enable-restore", second.epoch), { epoch: second.epoch, state: null, applied: false })
  assert.deepEqual(windows.get("window-a")!.commands, ["read", "disable-restore"])

  // A restored Preferences window has no host-observed opener.
  const restoredRegistry = new PreferencesWindowRegistry()
  const restored = fakePreferencesWindow()
  restoredRegistry.register(restored, { section: "general" })
  let calls = 0
  const orphan = await forwardOpenerStartupState(restoredRegistry.opener(restored)!, "read", undefined, async () => { calls++; return null })
  assert.equal(orphan.state, null)
  assert.equal(calls, 0)
  assert.equal(restoredRegistry.opener(preferences), undefined)
})
