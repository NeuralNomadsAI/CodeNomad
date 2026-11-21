import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron"
import { isDeviceSpeechRequest, isSpeechLocale, type MicrophoneRequest, type SpeechEngine } from "../../../desktop-speech/contract"
import { maxRemoteDictationTextBytes } from "../../../desktop-speech/remote-contract"
import { validateMainFrame } from "./ipc-security"
import { requireHttpUrl } from "./navigation-security"
import { isAllowedRendererOrigin } from "./renderer-origin"

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const dialogLifetimeMs = 5 * 60_000
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

function requestFields(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value) && owns(value, "action")) {
    return value as Record<string, unknown>
  }
  throw new Error("Invalid remote dictation request")
}

function hasFields(input: Record<string, unknown>, ...fields: string[]) {
  return Object.keys(input).length === fields.length + 1 && fields.every(field => owns(input, field))
}

type RemoteDocument = { frame: WebFrameMain; origin: string; destination: string }
type Pending = {
  id: string
  opener: BrowserWindow
  document: RemoteDocument
  dialog: BrowserWindow
  contents: WebContents
  owner: number
  target: URL
  frame?: WebFrameMain
  resolve: (value: string | null) => void
  timeout: NodeJS.Timeout
}

export function setupRemoteDictationIPC(ipc: Pick<IpcMain, "handle">, dependencies: {
  resolveRemote(sender: WebContents): BrowserWindow | undefined
  localUrl(): string | null
  readChoice(): SpeechEngine | null
  createDialog(opener: BrowserWindow): BrowserWindow
  revokeSpeech(owner: number, documentGone?: boolean): void
  rendererMicrophone?: {
    request(owner: number, input: MicrophoneRequest, remote: true): unknown
    revokeRendererMicrophone(owner: number): void
  }
  openSpeechPreferences(): Promise<void>
  isShuttingDown(): boolean
}) {
  const documents = new WeakMap<BrowserWindow, RemoteDocument>()
  const remoteTargets = new WeakMap<BrowserWindow, { origin: string; destination: string }>()
  let pending: Pending | undefined
  let dialogWindow: BrowserWindow | undefined

  const finish = (request: Pending, text: string | null) => {
    if (pending !== request) return
    pending = undefined
    clearTimeout(request.timeout)
    dependencies.revokeSpeech(request.owner, false)
    request.resolve(text)
    // Let Electron finish the close/navigation event (or settlement IPC) before destroying its sender.
    setImmediate(() => { if (!request.dialog.isDestroyed()) request.dialog.destroy() })
  }
  const revoke = () => { if (pending) finish(pending, null) }
  const liveDocument = (window: BrowserWindow, document: RemoteDocument) =>
    !window.isDestroyed() && !window.webContents.isDestroyed() && dependencies.resolveRemote(window.webContents) === window &&
    documents.get(window) === document && window.webContents.mainFrame === document.frame
  const liveOpener = (window: BrowserWindow, document: RemoteDocument) => {
    const target = remoteTargets.get(window)
    return target?.origin === document.origin && target.destination === document.destination && liveDocument(window, document)
  }

  function invalidateRemote(window: BrowserWindow) {
    documents.delete(window)
    if (pending?.opener === window) revoke()
  }

  function setRemoteTarget(window: BrowserWindow, target: URL, base: URL) {
    const previous = remoteTargets.get(window)
    const document = documents.get(window)
    const next = { origin: target.origin, destination: base.origin }
    const wasLive = document && liveOpener(window, document)
    if (pending?.opener === window) revoke()
    remoteTargets.set(window, next)
    return () => {
      // The provisional target fences IPC immediately. Navigation start permanently
      // invalidates the document; only a failure before that may restore its target.
      if (previous && wasLive && remoteTargets.get(window) === next && liveDocument(window, document) &&
        isAllowedRendererOrigin(window.webContents.getURL(), [document.origin])) {
        remoteTargets.set(window, previous)
      }
    }
  }

  function observeRemote(window: BrowserWindow) {
    const contents = window.webContents
    const invalidate = () => invalidateRemote(window)
    const retire = () => {
      invalidate()
      dependencies.rendererMicrophone?.revokeRendererMicrophone(contents.id)
    }
    contents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame) return
      if (!details.isSameDocument) invalidate()
      else if (pending?.opener === window) revoke()
    })
    contents.on("did-navigate", (_event, url) => {
      retire()
      try {
        const target = remoteTargets.get(window)
        if (target?.origin === requireHttpUrl(url, "Remote renderer").origin) {
          documents.set(window, { ...target, frame: contents.mainFrame })
        }
      } catch { /* No remote authority for this document. */ }
    })
    contents.on("render-process-gone", retire)
    contents.once("destroyed", retire)
    window.on("close", invalidate)
    window.once("closed", invalidate)
  }

  const liveDialog = (request: Pending) =>
    !dependencies.isShuttingDown() && liveOpener(request.opener, request.document) &&
    !request.dialog.isDestroyed() && !request.contents.isDestroyed() &&
    request.frame && request.contents.mainFrame === request.frame && request.contents.getURL() === request.target.href

  function requireDialog(event: IpcMainInvokeEvent): BrowserWindow | undefined {
    const request = pending
    if (!request || request.contents !== event.sender) return
    if (!liveDialog(request) || event.senderFrame !== request.frame) throw new Error("Remote dictation dialog is not active")
    validateMainFrame(event, request.dialog, [request.target.origin])
    return request.dialog
  }

  function mediaOrigins(sender: WebContents | null, mainFrame: boolean, audioOnly: boolean): string[] | undefined {
    if (!sender || dialogWindow?.isDestroyed() || dialogWindow?.webContents !== sender) return
    const request = pending
    return mainFrame && audioOnly && request && liveDialog(request) ? [request.target.origin] : []
  }

  ipc.handle("remote-dictation:request", (event, value: unknown) => {
    const opener = dependencies.resolveRemote(event.sender)
    const document = opener && documents.get(opener)
    if (!opener || !document || !liveOpener(opener, document)) throw new Error("Remote dictation requires a registered remote window")
    validateMainFrame(event, opener, [document.origin])
    if (dependencies.isShuttingDown()) throw new Error("Application is shutting down")
    const input = requestFields(value)

    if (input.action === "claimMicrophone" || input.action === "releaseMicrophone") {
      const current = requireHttpUrl(event.sender.getURL(), "Remote renderer")
      const secure = current.protocol === "https:" ||
        /^(localhost|\[::1\]|127(?:\.\d{1,3}){3})$/.test(current.hostname)
      if (!secure || !["/", "/index.html"].includes(current.pathname) ||
        !isDeviceSpeechRequest(input) ||
        (input.action !== "claimMicrophone" && input.action !== "releaseMicrophone") ||
        !dependencies.rendererMicrophone || (input.action === "claimMicrophone" && !opener.isFocused())) {
        throw new Error("Microphone use requires a secure remote application document")
      }
      return dependencies.rendererMicrophone.request(event.sender.id, input, true)
    }

    const readChoice = () => {
      try { return dependencies.readChoice() }
      catch { throw new Error("Device speech choice is unavailable") }
    }
    if (input.action === "read" && hasFields(input)) return readChoice()
    if (typeof input.id !== "string" || input.id.length !== 36 || !uuidV4.test(input.id)) {
      throw new Error("Invalid remote dictation request")
    }
    if (input.action === "cancel" && hasFields(input, "id")) {
      if (pending?.opener === opener && pending.document === document && pending.id === input.id) revoke()
      return null
    }
    if (input.action !== "begin" || !hasFields(input, "id", "locale") || !isSpeechLocale(input.locale)) {
      throw new Error("Invalid remote dictation request")
    }
    if (dialogWindow || !opener.isFocused()) throw new Error("Remote dictation is unavailable")
    if (readChoice() !== "hex") throw new Error("Remote dictation is unavailable")
    const localUrl = dependencies.localUrl()
    if (!localUrl) throw new Error("Local CodeNomad is unavailable")
    const target = requireHttpUrl(localUrl, "Local renderer")
    if (!(target.hostname === "localhost" || target.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(target.hostname)) ||
      target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
      throw new Error("Local CodeNomad is unavailable")
    }
    target.searchParams.set("dictationLocale", input.locale)
    target.hash = new URLSearchParams({ dictationDestination: document.destination }).toString()
    let dialog: BrowserWindow
    try { dialog = dependencies.createDialog(opener) } catch { throw new Error("Remote dictation dialog could not open") }
    dialogWindow = dialog
    const contents = dialog.webContents
    let resolve!: Pending["resolve"]
    const promise = new Promise<string | null>(settle => { resolve = settle })
    const request: Pending = { id: input.id, opener, document, dialog, contents, owner: contents.id, target, resolve,
      timeout: setTimeout(() => finish(request, null), dialogLifetimeMs).unref() }
    pending = request

    const close = () => finish(request, null)
    const forbidNavigation = (event: Electron.Event) => { event.preventDefault(); close() }
    contents.setWindowOpenHandler(() => ({ action: "deny" }))
    contents.on("page-title-updated", event => event.preventDefault())
    contents.on("will-frame-navigate", forbidNavigation)
    contents.on("will-redirect", forbidNavigation)
    let initialNavigation = true
    contents.on("did-start-navigation", details => {
      if (details.isMainFrame && initialNavigation && details.url === target.href && !details.isSameDocument) {
        initialNavigation = false
      } else close()
    })
    contents.on("did-navigate", (_event, url) => {
      if (url !== target.href || initialNavigation || request.frame) close()
      else request.frame = contents.mainFrame
    })
    const retire = () => {
      close()
      dependencies.rendererMicrophone?.revokeRendererMicrophone(request.owner)
    }
    contents.on("render-process-gone", retire)
    contents.once("destroyed", retire)
    dialog.on("close", forbidNavigation)
    dialog.once("closed", () => {
      if (dialogWindow === dialog) dialogWindow = undefined
      close()
    })
    dialog.once("hide", close)
    dialog.once("minimize", close)
    dialog.once("session-end", close)
    try {
      void dialog.loadURL(target.href).then(() => {
        if (pending !== request) return
        if (!liveDialog(request)) close()
        else dialog.show()
      }).catch(close)
    } catch { close() }
    return promise
  })

  ipc.handle("remote-dictation:settle", async (event, value: unknown) => {
    if (!requireDialog(event) || !pending) throw new Error("Remote dictation requires its local dialog")
    const input = requestFields(value)
    if (input.action === "complete" && hasFields(input, "text") && typeof input.text === "string" &&
      input.text.length <= maxRemoteDictationTextBytes && Buffer.byteLength(input.text) <= maxRemoteDictationTextBytes) {
      finish(pending, input.text)
    } else if ((input.action === "cancel" || input.action === "settings") && hasFields(input)) {
      const dialog = pending.dialog
      const closed = input.action === "settings" ? new Promise<void>(resolve => dialog.once("closed", resolve)) : undefined
      finish(pending, null)
      if (closed) {
        await closed
        if (!dependencies.isShuttingDown() && dependencies.localUrl()) await dependencies.openSpeechPreferences()
      }
    } else throw new Error("Invalid remote dictation settlement")
    return null
  })

  return { observeRemote, setRemoteTarget, requireDialog, mediaOrigins, window: () => dialogWindow, revoke }
}
