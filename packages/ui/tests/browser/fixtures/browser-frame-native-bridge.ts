// Native IPC is the fixture boundary; layout, observers, Solid ownership and
// BrowserFrame itself run in Chromium or a real Electron guest host.
import { BrowserPreviewOwners } from "../../../../electron-app/electron/main/browser-preview-owners"
type Call = { command: string; payload?: any; registrationId?: string }
const requestedHost = new URLSearchParams(location.search).get("host")
const host = requestedHost === "electron" || requestedHost === "web" ? requestedHost : "tauri"
const calls: Call[] = []
const callbacks = new Map<number, (event: unknown) => void>()
const events = new Map<number, string>()
const ownsPreview = new URLSearchParams(location.search).has("ownership")
const owners = new BrowserPreviewOwners<string>()
const ownerWindow = "local-fixture"
const histories = new Map<string, { entries: Array<{ id: number; url: string }>; index: number }>()
let historyId = 0
let callbackId = 0
let pendingEmulation: (() => void) | undefined
let pendingRegistration: { resolve: () => void; reject: (error: Error) => void } | undefined
let pendingOpenTarget: (() => void) | undefined
let pendingOwnership: (() => void) | undefined

export const nativeFixture = {
  calls,
  errors: [] as string[],
  locations: [] as string[],
  failUpdates: false,
  failEmulation: false,
  deferRegistration: false,
  deferEmulation: false,
  deferOpenTarget: false,
  deferOwnership: false,
  ownerOf: (sessionId: string) => owners.get(sessionId)?.instanceId,
  beforeNavigate: undefined as (() => void) | undefined,
  settleOpenTarget() { pendingOpenTarget?.(); pendingOpenTarget = undefined },
  settleOwnership() { pendingOwnership?.(); pendingOwnership = undefined },
  async ownership(input: any) {
    const { sessionId, instanceId, revision } = input
    if (input.action === "release") {
      for (const release of owners.release(ownerWindow, instanceId)) {
        this.emit("browser-target:ownership", { sessionId: release.sessionId, revision: release.revision, owner: null })
      }
    } else if (input.action === "focus") {
      const owner = owners.get(sessionId)
      if (owner?.revision === revision) this.emit("browser-target:focus-owner", { sessionId, instanceId: owner?.instanceId })
    } else {
      const { owner } = owners.request(sessionId, ownerWindow, instanceId, revision)
      if (this.deferOwnership) await new Promise<void>(resolve => { pendingOwnership = resolve })
      return { sessionId, revision: owner.revision, owner: { instanceId: owner.instanceId, sameWindow: true } }
    }
  },
  emit(event: string, payload: unknown) {
    for (const [id, name] of events) if (name === event) callbacks.get(id)?.({ payload })
  },
  settleEmulation() { pendingEmulation?.(); pendingEmulation = undefined },
  settleRegistration(reject = false) {
    if (!pendingRegistration) throw new Error("No pending registration")
    if (reject) pendingRegistration.reject(new Error("Registration failed"))
    else pendingRegistration.resolve()
    pendingRegistration = undefined
  },
  navigate(registrationId: string, url: string) {
    const history = histories.get(registrationId)
    if (history) { history.entries = [...history.entries.slice(0, history.index + 1), { id: ++historyId, url }]; history.index++ }
    this.emit("browser-target:navigated", { registrationId, url })
  },
  listenerCount: () => callbacks.size,
}

// Like the Rust controller, a target answers actions only once its registration completed.
const registering = new Set<string>()

async function invoke(command: string, args: any = {}) {
  calls.push({ command, ...args })
  if (command === "browser_target_action" && registering.has(args.payload.registrationId)) throw new Error("Browser target is not registered")
  if (command === "plugin:event|listen") {
    events.set(args.handler, args.event)
    return args.handler
  }
  if (command === "browser_target_ownership") return nativeFixture.ownership(args.input)
  if (command === "browser_target_claim_open" && args.response.kind === "target") {
    if (nativeFixture.deferOpenTarget) await new Promise<void>(resolve => { pendingOpenTarget = resolve })
    return true
  }
  if (command === "browser_target_release_open") return true
  if (command === "browser_target_register") histories.set(args.payload.registrationId, args.payload.openRequestId
    ? { entries: [], index: -1 } : { entries: [{ id: ++historyId, url: args.payload.url }], index: 0 })
  if (command === "browser_target_action" && args.payload.action === "history") return histories.get(args.payload.registrationId)
  if (command === "browser_target_action" && args.payload.action === "navigate") {
    nativeFixture.beforeNavigate?.()
    nativeFixture.navigate(args.payload.registrationId, args.payload.url)
  }
  if (command === "browser_target_action" && args.payload.action === "history-go") {
    const history = histories.get(args.payload.registrationId)!
    history.index = history.entries.findIndex(entry => entry.id === args.payload.entryId)
    nativeFixture.emit("browser-target:navigated", { registrationId: args.payload.registrationId, url: history.entries[history.index].url })
  }
  if (command === "browser_target_action" && args.payload.action === "emulate" && nativeFixture.failEmulation) throw new Error("Emulation failed")
  if (command === "browser_target_action" && args.payload.action === "emulate" && nativeFixture.deferEmulation) await new Promise<void>(resolve => { pendingEmulation = resolve })
  if (command === "browser_target_register" && nativeFixture.deferRegistration) {
    const id = args.payload.registrationId
    registering.add(id)
    return new Promise<void>((resolve, reject) => {
      pendingRegistration = {
        // The Rust controller publishes the target and starts its first load before answering.
        resolve: () => {
          registering.delete(id)
          nativeFixture.emit("browser-target:navigated", { registrationId: id, url: args.payload.url })
          resolve()
        },
        reject: (error) => { registering.delete(id); reject(error) },
      }
    })
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
window.__CODENOMAD_BROWSER_CAPABILITIES__ = { embedding: true, history: true,
  emulation: !new URLSearchParams(location.search).has("dimensionsOnly"),
  automation: true, ...(ownsPreview && { ownership: true }),
  ...(["macos","linux"].includes(new URLSearchParams(location.search).get("platform")??"") ? {reason:"webkit" as const}: {}) }
Object.assign(window, {
  nativeFixture,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "local-fixture" }, currentWebview: { label: "local-fixture" } },
    invoke,
    metadata: { currentWindow: { label: ownerWindow }, currentWebview: { label: ownerWindow } },
    transformCallback(callback: (event: unknown) => void) {
      callbacks.set(++callbackId, callback)
      return callbackId
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: {
    unregisterListener(_event: string, id: number) { callbacks.delete(id); events.delete(id) },
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
