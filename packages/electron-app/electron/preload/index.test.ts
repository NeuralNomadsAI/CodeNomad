import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

test("CLI event disposers remove only their own wrapper listeners", () => {
  const listeners = new Map<string, Set<Function>>()
  let api: Record<string, Function> | undefined
  const ipcRenderer = {
    on(channel: string, listener: Function) {
      const channelListeners = listeners.get(channel) ?? new Set()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    },
    removeListener(channel: string, listener: Function) { listeners.get(channel)?.delete(listener) },
    invoke() {},
  }
  vm.runInNewContext(readFileSync(new URL("./index.cjs", import.meta.url), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld(name: string, value: Record<string, Function>) { if (name === "electronAPI") api = value } },
      ipcRenderer,
      webUtils: {},
    }),
    process: { argv: [] },
  })

  for (const [subscribe, channel] of [
    ["onCliStatus", "cli:status"],
    ["onCliError", "cli:error"],
    ["onBrowserOpenRequest", "browser-target:open"],
  ] as const) {
    const calls: string[] = []
    const disposeFirst = api![subscribe]((value: string) => calls.push(`first:${value}`))
    api![subscribe]((value: string) => calls.push(`second:${value}`))
    disposeFirst()
    for (const listener of listeners.get(channel) ?? []) listener({}, "event")
    assert.deepEqual(calls, ["second:event"])
  }
})

test("Preferences preload exposes only section and frame controls", () => {
  const listeners = new Map<string, Set<Function>>()
  const exposed = new Map<string, unknown>()
  const invoked: string[] = []
  const ipcRenderer = {
    on(channel: string, listener: Function) {
      const values = listeners.get(channel) ?? new Set()
      values.add(listener)
      listeners.set(channel, values)
    },
    removeListener(channel: string, listener: Function) { listeners.get(channel)?.delete(listener) },
    invoke(channel: string) { invoked.push(channel); return Promise.resolve() },
  }
  vm.runInNewContext(readFileSync(new URL("./index.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value) }, ipcRenderer, webUtils: {} }),
    process: { argv: ["--codenomad-window-context=preferences"] },
  })

  const api = exposed.get("electronAPI") as Record<string, Function>
  assert.deepEqual(Object.keys(api), [
    "onCliStatus", "onCliError", "getCliStatus", "restartCli", "openDialog", "showNotification", "openRemoteWindow",
    "getPreferencesSection", "getPreferencesRequest", "preferencesReady", "acceptPreferencesRequest", "resolvePreferencesTransition",
    "onPreferencesSection", "onPreferencesCloseRequested", "onPreferencesTransitionRequested",
    "minimizeWindow", "toggleMaximizeWindow", "closeWindow",
  ])
  assert.equal(exposed.get("__CODENOMAD_WINDOW_CONTEXT__"), "preferences")
  assert.equal(exposed.get("__CODENOMAD_WINDOW_ID__"), null)
  api.getPreferencesSection()
  api.getPreferencesRequest()
  api.preferencesReady()
  api.acceptPreferencesRequest({ section: "providers" })
  api.resolvePreferencesTransition(4, true)
  api.minimizeWindow()
  api.toggleMaximizeWindow()
  api.closeWindow()
  assert.deepEqual(invoked, ["preferences:getSection", "preferences:getSection", "preferences:ready", "preferences:acceptRequest", "preferences:resolveTransition", "preferences:minimize", "preferences:toggleMaximize", "preferences:close"])

  const sections: string[] = []
  const dispose = api.onPreferencesSection((section: string) => sections.push(section))
  for (const listener of listeners.get("preferences:section") ?? []) listener({}, "advanced")
  dispose()
  assert.deepEqual(sections, ["advanced"])
  assert.equal(listeners.get("preferences:section")?.size, 0)

  let closeRequests = 0
  const disposeClose = api.onPreferencesCloseRequested(() => closeRequests++)
  for (const listener of listeners.get("preferences:close-requested") ?? []) listener({})
  disposeClose()
  assert.equal(closeRequests, 1)

  const transitions: unknown[] = []
  const disposeTransition = api.onPreferencesTransitionRequested((value: unknown) => transitions.push(value))
  for (const listener of listeners.get("preferences:transition-requested") ?? []) listener({}, { id: 4 })
  disposeTransition()
  assert.deepEqual(transitions, [{ id: 4 }])
})

test("Developer Mode is exposed to local windows only", () => {
  const source = readFileSync(new URL("./index.cjs", import.meta.url), "utf8")
  const expose = (argv: string[]) => {
    let api: Record<string, Function> | undefined
    vm.runInNewContext(source, {
      require: () => ({
        contextBridge: { exposeInMainWorld(name: string, value: Record<string, Function>) { if (name === "electronAPI") api = value } },
        ipcRenderer: { invoke() {}, on() {}, removeListener() {} },
        webUtils: {},
      }),
      process: { argv },
    })
    return api!
  }

  assert.equal(typeof expose([]).getDeveloperMode, "function")
  assert.equal(typeof expose([]).setDeveloperMode, "function")
  assert.equal(typeof expose([]).showTitlebarMenu, "function")
  assert.equal(expose(["--codenomad-window-context=remote"]).getDeveloperMode, undefined)
  assert.equal(expose(["--codenomad-window-context=remote"]).showTitlebarMenu, undefined)
  assert.equal(expose(["--codenomad-window-context=preferences"]).getDeveloperMode, undefined)
  assert.equal(expose(["--codenomad-window-context=preferences"]).showTitlebarMenu, undefined)
})
