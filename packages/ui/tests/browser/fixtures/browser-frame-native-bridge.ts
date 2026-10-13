// Native IPC is the fixture boundary; layout, observers, Solid ownership and
// BrowserFrame itself run in Chromium or a real Electron guest host.
type Call = { command: string; payload?: any; registrationId?: string }
const requestedHost = new URLSearchParams(location.search).get("host")
const host = requestedHost === "electron" || requestedHost === "web" ? requestedHost : "tauri"
const calls: Call[] = []
const callbacks = new Map<number, (event: unknown) => void>()
const histories = new Map<string, { entries: Array<{ id: number; url: string }>; index: number }>()
let historyId = 0
let callbackId = 0
let pendingRegistration: { resolve: () => void; reject: (error: Error) => void } | undefined

export const nativeFixture = {
  calls,
  errors: [] as string[],
  locations: [] as string[],
  failUpdates: false,
  failEmulation: false,
  deferRegistration: false,
  settleRegistration(reject = false) {
    if (!pendingRegistration) throw new Error("No pending registration")
    if (reject) pendingRegistration.reject(new Error("Registration failed"))
    else pendingRegistration.resolve()
    pendingRegistration = undefined
  },
  navigate(registrationId: string, url: string) {
    const history = histories.get(registrationId)
    if (history) { history.entries = [...history.entries.slice(0, history.index + 1), { id: ++historyId, url }]; history.index++ }
    for (const callback of callbacks.values()) callback({ payload: { registrationId, url } })
  },
  listenerCount: () => callbacks.size,
}

async function invoke(command: string, args: any = {}) {
  calls.push({ command, ...args })
  if (command === "plugin:event|listen") return args.handler
  if (command === "browser_target_register") histories.set(args.payload.registrationId, { entries: [{ id: ++historyId, url: args.payload.url }], index: 0 })
  if (command === "browser_target_action" && args.payload.action === "history") return histories.get(args.payload.registrationId)
  if (command === "browser_target_action" && args.payload.action === "navigate") nativeFixture.navigate(args.payload.registrationId, args.payload.url)
  if (command === "browser_target_action" && args.payload.action === "history-go") {
    const history = histories.get(args.payload.registrationId)!
    history.index = history.entries.findIndex(entry => entry.id === args.payload.entryId)
    for (const callback of callbacks.values()) callback({ payload: { registrationId: args.payload.registrationId, url: history.entries[history.index].url } })
  }
  if (command === "browser_target_action" && args.payload.action === "emulate" && nativeFixture.failEmulation) throw new Error("Emulation failed")
  if (command === "browser_target_register" && nativeFixture.deferRegistration) {
    return new Promise<void>((resolve, reject) => { pendingRegistration = { resolve, reject } })
  }
  if (command === "browser_target_update" && nativeFixture.failUpdates) {
    // IPC completes asynchronously. Avoid starving Chromium's event loop even
    // when exercising the broken immediate-retry implementation.
    await new Promise(resolve => setTimeout(resolve, 10))
    throw new Error("Native target unavailable")
  }
}

window.__CODENOMAD_RUNTIME_HOST__ = host
window.__CODENOMAD_WINDOW_CONTEXT__ = "local"
Object.assign(window, {
  nativeFixture,
  __TAURI_INTERNALS__: {
    invoke,
    transformCallback(callback: (event: unknown) => void) {
      callbacks.set(++callbackId, callback)
      return callbackId
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: {
    unregisterListener(_event: string, id: number) { callbacks.delete(id) },
  },
})
if (host === "electron") {
  const native = (window as any).browserHistoryNative
  Object.assign(window, { electronAPI: {
    registerBrowserTarget: async (payload: unknown) => { await invoke("browser_target_register", { payload }); await native?.register(payload) },
    unregisterBrowserTarget: async (registrationId: string) => { await invoke("browser_target_unregister", { registrationId }); await native?.unregister(registrationId) },
    ...(native ? { browserTargetHistory: native.history } : {}),
    emulateBrowserTarget: (registrationId: string, preset: string) => invoke("browser_target_action", { registrationId, payload: { action: "emulate", preset } }),
  } })
}
