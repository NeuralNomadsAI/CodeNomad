import assert from "node:assert/strict"
import test from "node:test"
import type { BrowserWindow } from "electron"
import { createPreferencesUrl, PreferencesWindowRegistry, requirePreferencesRequest, requirePreferencesSection } from "./preferences-window"
import { createClientState, parseClientState } from "./client-state-envelope"

function fakeWindow() {
  const windowEvents = new Map<string, Function>()
  const contentEvents = new Map<string, Function>()
  const calls: unknown[] = []
  const webContents = {
    isDestroyed: () => false,
    on: (name: string, handler: Function) => contentEvents.set(name, handler),
    send: (channel: string, value?: unknown) => calls.push([channel, value]),
  }
  const window = {
    webContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    on: (name: string, handler: () => void) => windowEvents.set(name, handler),
  } as unknown as BrowserWindow
  return { window, webContents, windowEvents, contentEvents, calls }
}

test("Preferences registry reuses one window and delivers the latest section after loading", () => {
  const registry = new PreferencesWindowRegistry()
  const first = fakeWindow()
  registry.register(first.window, { section: "general" })

  assert.equal(registry.reuse({ section: "speech", instanceId: "workspace-1" }), first.window)
  assert.deepEqual(first.calls, ["show", "focus"])
  first.contentEvents.get("did-finish-load")?.()
  assert.deepEqual(first.calls, ["show", "focus", ["preferences:section", { section: "speech", instanceId: "workspace-1" }]])

  registry.reuse({ section: "advanced" })
  assert.deepEqual(first.calls.slice(-3), ["show", "focus", ["preferences:section", { section: "advanced" }]])
  assert.equal(registry.resolve(first.webContents as never), first.window)
  assert.deepEqual(registry.request(first.window), { section: "advanced" })

  first.windowEvents.get("closed")?.()
  assert.equal(registry.current(), undefined)
  const second = fakeWindow()
  registry.register(second.window, { section: "general" })
  assert.equal(registry.current(), second.window)
})

test("Preferences registry guards native close only after the renderer is ready", () => {
  const registry = new PreferencesWindowRegistry()
  const target = fakeWindow()
  registry.register(target.window, { section: "config-files" })
  const event = { prevented: false, preventDefault() { this.prevented = true } }

  target.windowEvents.get("close")?.(event)
  assert.equal(event.prevented, false)
  registry.markReady(target.window)
  target.windowEvents.get("close")?.(event)
  assert.equal(event.prevented, true)
  assert.deepEqual(target.calls.at(-1), ["preferences:close-requested", undefined])

  registry.reuse({ section: "providers", instanceId: "pending" })
  assert.deepEqual(registry.request(target.window), { section: "config-files" })
  registry.acceptRequest(target.window, { section: "providers", instanceId: "pending" })
  assert.deepEqual(registry.request(target.window), { section: "providers", instanceId: "pending" })

  registry.prepareNavigation(target.window)
  registry.reuse({ section: "advanced" })
  assert.deepEqual(registry.request(target.window), { section: "advanced" })
  target.contentEvents.get("did-start-navigation")?.({}, "#section", true, true)
  assert.equal(registry.isReady(target.window), true)
  target.contentEvents.get("did-start-navigation")?.({}, "http://localhost:3000/", false, true)
  assert.equal(registry.isReady(target.window), false)
})

test("Preferences sections and backend URLs are constrained", () => {
  assert.equal(requirePreferencesSection("config-files"), "config-files")
  assert.deepEqual(requirePreferencesRequest("providers", { instanceId: "workspace-1", location: { directory: "C:\\repo", workspaceID: "worktree-1" } }), {
    section: "providers", instanceId: "workspace-1", location: { directory: "C:\\repo", workspaceID: "worktree-1" },
  })
  assert.throws(() => requirePreferencesSection("workspace"), /Invalid preferences section/)
  assert.equal(createPreferencesUrl("https://localhost:3000/app?keep=yes", "chat").toString(), "https://localhost:3000/app?keep=yes&preferences=chat")
  assert.throws(() => createPreferencesUrl("file:///tmp/index.html", "general"), /HTTP or HTTPS/)
  assert.deepEqual(requirePreferencesRequest("providers", { instanceId: "workspace-1", workspacePath: "C:\\repo", location: { directory: "/mnt/c/repo" } }), {
    section: "providers", instanceId: "workspace-1", workspacePath: "C:\\repo", location: { directory: "/mnt/c/repo" },
  })
  for (const workspacePath of ["", 42, "x".repeat(32769), "bad\0path"]) {
    assert.throws(() => requirePreferencesRequest("providers", { workspacePath }), /Invalid Preferences workspace path/)
  }
})

test("server-bound Preferences survives normalization, guarded reuse, acceptance and the strict state codec", () => {
  const request = requirePreferencesRequest("providers", { serverId: "unknown-A", instanceId: "same", workspacePath: "C:\\App/", location: { directory: "/App//" }, scrollTop: 123 })
  assert.equal(request.serverId, "unknown-A")
  const registry = new PreferencesWindowRegistry(), target = fakeWindow()
  registry.register(target.window, request)
  target.contentEvents.get("did-finish-load")?.()
  registry.markReady(target.window)
  const next = { ...request, serverId: "B" }
  registry.reuse(next)
  assert.deepEqual(registry.request(target.window), request)
  registry.acceptRequest(target.window, next)
  assert.deepEqual(registry.request(target.window), next)
  const state = createClientState()
  state.preferences = next
  state.lastPreferences = request
  const parsed = parseClientState(JSON.stringify(state))
  assert.equal(parsed.unsupportedFutureEnvelope, false)
  assert.deepEqual(parsed.state.preferences, next)
  assert.deepEqual(parsed.state.lastPreferences, request)
  for (const serverId of [null, undefined, "", "a/b", "a".repeat(129), 42]) {
    assert.throws(() => requirePreferencesRequest("providers", { serverId }), /server ID/)
  }
  assert.throws(() => requirePreferencesRequest("providers", { serverId: "A", token: "forbidden" }), /context/)
  assert.equal(Object.prototype.hasOwnProperty.call(requirePreferencesRequest("general", {}), "serverId"), false)
  assert.equal(parseClientState(JSON.stringify({ ...state, preferences: { ...next, serverId: null } })).unsupportedFutureEnvelope, true)
  for (const workspacePath of ["", 42, "x".repeat(32769), "bad\0path"]) {
    assert.equal(parseClientState(JSON.stringify({ ...state, preferences: { ...next, workspacePath } })).unsupportedFutureEnvelope, true)
  }
  state.preferences = { section: "general" }
  state.lastPreferences = { section: "general" }
  const legacy = parseClientState(JSON.stringify(state)).state
  assert.deepEqual(legacy.preferences, { section: "general" })
  assert.deepEqual(legacy.lastPreferences, { section: "general" })
})
