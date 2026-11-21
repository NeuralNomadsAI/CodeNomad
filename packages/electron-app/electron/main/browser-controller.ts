import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import type { BrowserWindow, WebContents } from "electron"
import { isBrowserUrlAllowed } from "./browser-webview-security"
import { setBrowserEmulation } from "./browser-emulation"
import { executeCdpOperation } from "../../../server/src/automation/page/cdp-driver"
import { parsePageOperation, pageEnvelope } from "../../../server/src/automation/page/operations"
import { PAGE_DRIVER_VERSION } from "../../../server/src/automation/page/protocol"
import { setBrowserLogicalAddress } from "./browser-presentation"

const electron = () => createRequire(import.meta.url)("electron") as typeof import("electron")

interface BrowserControllerElectron {
  fromId(id: number): WebContents | undefined | null
  fromWebContents(contents: WebContents): BrowserWindow | null
}

interface RegistrationInput {
  logicalAddress?: string
  sessionId: string
  registrationId: string
  guestWebContentsId: number
}

interface Registration extends RegistrationInput {
  owner: WebContents
  guest: WebContents
  generation: string
  visibilityVersion: number
}

interface OpenClaim {
  sessionID: string
  url: string
  expiresAt: number
  owner?: WebContents
  failedOwners: Set<WebContents>
}

type BrowserCommand =
  | { action: "open"; url: string }
  | { action: "navigate"; url: string }
  | { action: "screenshot" }

const noTarget = "No visible local browser target for this session"
const staleTarget = "Browser target is stale; probe again"
const openTimeout = "Timed out waiting for CodeNomad to open the browser preview"

function requireWitness(target: unknown): string {
  if (!validId(target, 128)) throw new Error("A current browser target is required")
  return target
}

interface PageLease {
  sessionID: string
  operationID: string
  registration: Registration
  generation: string
  expires: number
  timer: NodeJS.Timeout
}

export class BrowserController {
  private readonly registrations = new Map<string, Registration>()
  private readonly observedGuests = new Map<number, number>()
  private readonly pageLeases = new Map<string, PageLease>()
  private readonly controlledDetach = new WeakSet<WebContents>()
  private readonly documentWatches = new WeakMap<WebContents, boolean>()
  private readonly commandQueues = new WeakMap<WebContents, Promise<void>>()
  private readonly navigationVersions = new WeakMap<WebContents, number>()
  private readonly documentRoots = new WeakMap<WebContents, number>()
  private readonly loadResults = new WeakMap<WebContents, { at: number; url: string; startedUrl: string; error?: Error }>()
  private readonly openClaims = new Map<string, OpenClaim>()

  constructor(
    private readonly requestOpen: (sessionID: string, url: string, requestID: string) => void,
    private readonly electronApi: BrowserControllerElectron = {
      fromId: (id) => electron().webContents.fromId(id),
      fromWebContents: (contents) => electron().BrowserWindow.fromWebContents(contents),
    },
  ) {}

  observeGuest(owner: WebContents, guest: WebContents): void {
    this.observedGuests.set(guest.id, owner.id)
    this.navigationVersions.set(guest, 0)
    let startedUrl = guest.getURL()
    const invalidate = () => this.invalidateDocument(guest)
    guest.on("did-navigate", invalidate)
    guest.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) invalidate()
    })
    guest.on("did-frame-navigate", (_event, _url, _code, _status, isMainFrame) => {
      if (isMainFrame) invalidate()
    })
    guest.on("render-process-gone", () => {
      invalidate()
      this.releaseTarget(guest)
    })
    guest.debugger.on("message", (_event, method, params, sessionId) => {
      if (!sessionId && method === "Page.documentOpened" && params?.frame?.id && !params.frame.parentId) invalidate()
    })
    guest.debugger.on("detach", () => {
      this.documentWatches.delete(guest)
      if (!this.controlledDetach.has(guest)) invalidate()
    })
    guest.on("did-start-navigation", (_event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) { startedUrl = url; invalidate() }
    })
    guest.on("did-finish-load", () => this.loadResults.set(guest, { at: Date.now(), url: guest.getURL(), startedUrl }))
    guest.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.loadResults.set(guest, {
        at: Date.now(),
        url,
        startedUrl,
        error: new Error(`${description} (${code}) loading ${url}`),
      })
    })
    guest.once("destroyed", () => {
      this.observedGuests.delete(guest.id)
      this.documentWatches.delete(guest)
      this.documentRoots.delete(guest)
      this.releaseGuest(guest)
      for (const [id, registration] of this.registrations) {
        if (registration.guest.id === guest.id) this.registrations.delete(id)
      }
    })
  }

  register(owner: WebContents, input: RegistrationInput): void {
    if (!validId(input.sessionId, 256) || !validId(input.registrationId, 128) || !Number.isInteger(input.guestWebContentsId)) {
      throw new Error("Invalid browser target registration")
    }
    const guest = this.electronApi.fromId(input.guestWebContentsId)
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview"
      || guest.hostWebContents !== owner || this.observedGuests.get(guest.id) !== owner.id) {
      throw new Error("Browser guest does not belong to this window")
    }
    const previous = this.registrations.get(input.registrationId)
    setBrowserLogicalAddress(guest, input.logicalAddress)
    if (previous) this.releaseTarget(previous.guest)
    this.registrations.set(input.registrationId, { ...input, owner, guest, generation: randomUUID(), visibilityVersion: 0 })
  }

  async emulate(owner: WebContents, registrationId: unknown, preset: unknown): Promise<void> {
    const registration = typeof registrationId === "string" ? this.registrations.get(registrationId) : undefined
    if (!registration || registration.owner !== owner) throw new Error("Browser target does not belong to this window")
    await this.enqueue(registration.guest, async () => {
      if (this.registrations.get(registration.registrationId) !== registration || owner.isDestroyed() || registration.guest.isDestroyed()) {
        throw new Error("Browser target changed before emulation")
      }
      this.releaseGuest(registration.guest)
      const { guest } = registration
      await setBrowserEmulation(guest, preset, () => {
        if (!this.documentWatches.get(guest)) return false
        this.documentWatches.set(guest, false)
        return true
      })
    })
  }

  unregister(owner: WebContents, registrationId: unknown): void {
    if (typeof registrationId !== "string") return
    const registration = this.registrations.get(registrationId)
    if (registration?.owner === owner) {
      this.releaseTarget(registration.guest)
      this.registrations.delete(registrationId)
    }
  }

  async history(owner: WebContents, guestId: unknown, entryId?: unknown): Promise<unknown> {
    const guest = typeof guestId === "number" && Number.isInteger(guestId) ? this.electronApi.fromId(guestId) : undefined
    const owned = () => guest && !owner.isDestroyed() && !guest.isDestroyed() && guest.getType() === "webview"
      && guest.hostWebContents === owner && this.observedGuests.get(guest.id) === owner.id
    if (!guest || !owned()) throw new Error("Browser target does not belong to this window")
    // Retained guest ownership is separate from visible automation registration.
    // A hidden guest can publish its journal without becoming an agent target.
    return this.enqueue(guest, async () => {
      if (!owned()) throw new Error("Browser target changed before history access")
      // CDP supplies stable entry IDs, including same-URL and fragment entries.
      return withDebugger(guest, Date.now() + 5000, () => this.detachDebugger(guest), async debuggerSession => {
        const result = await debuggerSession.sendCommand("Page.getNavigationHistory") as { currentIndex: number; entries: Array<{ id: number; url: string }> }
        if (entryId !== undefined) {
          const entry = result.entries.find(entry => entry.id === entryId)
          if (!Number.isInteger(entryId) || !entry || !isBrowserUrlAllowed(entry.url)) throw new Error("Invalid browser history entry")
          if (!owned()) throw new Error("Browser target changed before history navigation")
          await debuggerSession.sendCommand("Page.navigateToHistoryEntry", { entryId })
          return
        }
        const start = Math.max(0, result.currentIndex - 16)
        const entries = result.entries.slice(start, start + 32).filter(entry => isBrowserUrlAllowed(entry.url) && entry.url.length <= 2048)
        const current = result.entries[result.currentIndex]
        return { entries: entries.map(({ id, url }) => ({ id, url })), index: entries.findIndex(entry => entry.id === current?.id) }
      })
    })
  }

  claimOpen(owner: WebContents, requestID: unknown): boolean {
    if (typeof requestID !== "string" || owner.isDestroyed()) return false
    const claim = this.openClaims.get(requestID)
    if (!claim || Date.now() >= claim.expiresAt || claim.failedOwners.has(owner) || (claim.owner && claim.owner !== owner)) return false
    claim.owner = owner
    return true
  }

  releaseOpen(owner: WebContents, requestID: unknown): boolean {
    if (typeof requestID !== "string") return false
    const claim = this.openClaims.get(requestID)
    if (!claim || Date.now() >= claim.expiresAt || claim.owner !== owner) return false
    claim.owner = undefined
    claim.failedOwners.add(owner)
    this.requestOpen(claim.sessionID, claim.url, requestID)
    return true
  }

  observeOwner(window: BrowserWindow): void {
    // BrowserWindow's native getters throw once "closed" is emitted. Retain
    // the owner identity while it is alive; cleanup only compares references.
    const owner = window.webContents
    window.once("closed", () => this.removeOwner(owner))
    const revokeVisibility = () => {
      for (const registration of this.registrations.values()) {
        if (registration.owner !== owner) continue
        registration.visibilityVersion++
        this.releaseTarget(registration.guest)
      }
    }
    window.on("hide", revokeVisibility)
    window.on("minimize", revokeVisibility)
  }

  private removeOwner(owner: WebContents): void {
    for (const [id, registration] of this.registrations) {
      if (registration.owner === owner) {
        this.releaseTarget(registration.guest)
        this.registrations.delete(id)
      }
    }
    for (const requestID of this.openClaims.keys()) this.releaseOpen(owner, requestID)
  }

  async probe(sessionID: string, deadline = Number.POSITIVE_INFINITY): Promise<{ available: true; target: string }> {
    ensureDeadline(deadline)
    const registration = this.resolve(sessionID)
    const { guest } = registration
    const generation = this.pageGeneration(registration)
    const target = await this.enqueue(guest, async () => {
      const check = () => {
        ensureDeadline(deadline)
        if (this.resolveWitness(sessionID) !== registration || this.pageGeneration(registration) !== generation) throw new Error(staleTarget)
      }
      check()
      if (!this.documentWatches.has(guest)) {
        const ownsDebugger = !guest.debugger.isAttached()
        if (ownsDebugger) guest.debugger.attach("1.3")
        try {
          // Observe the renderer even between page leases.
          await withDeadline(() => guest.debugger.sendCommand("Page.enable"), deadline)
          check()
          if (!guest.debugger.isAttached()) throw new Error(staleTarget)
          this.documentWatches.set(guest, ownsDebugger)
        } catch (error) {
          if (ownsDebugger) this.detachDebugger(guest)
          throw error
        }
      }
      await this.refreshDocument(guest, deadline, check)
      return this.pageGeneration(registration)
    })
    ensureDeadline(deadline)
    this.resolveWitness(sessionID, target)
    return { available: true, target }
  }

  async execute(sessionID: string, command: BrowserCommand, deadline = Number.POSITIVE_INFINITY, target?: unknown): Promise<unknown> {
    if (command.action === "open") return this.open(sessionID, command.url, deadline)
    if (command.action !== "navigate" && command.action !== "screenshot") throw new Error("Invalid browser command")
    const registration = this.resolveWitness(sessionID, requireWitness(target))
    const { guest, visibilityVersion } = registration
    const document = this.pageGeneration(registration)
    const check = (exactDocument: boolean) => {
      ensureDeadline(deadline)
      if (this.resolveWitness(sessionID, exactDocument ? document : undefined) !== registration
        || registration.visibilityVersion !== visibilityVersion) throw new Error(staleTarget)
    }
    return this.enqueue(guest, async () => {
      const checkDocument = () => check(true)
      await this.refreshDocument(guest, deadline, checkDocument)
      checkDocument()
      switch (command.action) {
        case "navigate": {
          if (!isBrowserUrlAllowed(command.url)) throw new Error("Browser navigation requires a credential-free HTTP(S) URL")
          await withDeadline(() => guest.loadURL(command.url), deadline, () => guest.stop())
          check(false)
          return { url: guest.getURL() }
        }
        case "screenshot": {
          const result = await withDeadline(() => guest.debugger.sendCommand("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
          }), deadline) as { data?: unknown }
          await this.refreshDocument(guest, deadline, checkDocument)
          checkDocument()
          if (typeof result.data !== "string" || result.data.length > 16 * 1024 * 1024) throw new Error("Browser screenshot is unavailable or too large")
          return { image: { mime: "image/png", data: result.data }, url: guest.getURL() }
        }
        default: throw new Error("Invalid browser command")
      }
    })
  }

  private async open(sessionID: string, url: string, deadline: number): Promise<{ url: string }> {
    if (!isBrowserUrlAllowed(url)) throw new Error("Browser navigation requires a credential-free HTTP(S) URL")
    ensureDeadline(deadline)
    try {
      const registration = this.resolve(sessionID)
      const { guest, visibilityVersion } = registration
      const check = () => this.assertCurrentOpenTarget(registration, visibilityVersion, deadline)
      return this.enqueue(guest, async () => {
        check()
        await withDeadline(() => guest.loadURL(url), deadline, () => guest.stop())
        check()
        return { url: guest.getURL() }
      })
    } catch (error) {
      if (!(error instanceof Error) || error.message !== noTarget) throw error
    }

    const requestID = randomUUID()
    const requestedAt = Date.now()
    const claim: OpenClaim = { sessionID, url, expiresAt: Math.min(deadline, requestedAt + 10_000), failedOwners: new Set() }
    this.openClaims.set(requestID, claim)
    return new Promise<{ url: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(interval)
        reject(new Error(claim.expiresAt === deadline ? "Native request expired before execution" : openTimeout))
      }, claim.expiresAt - requestedAt)
      const interval = setInterval(() => {
        try {
          ensureDeadline(deadline)
          if (Date.now() >= claim.expiresAt) throw new Error(openTimeout)
          const registration = this.resolve(sessionID)
          const { guest, owner, visibilityVersion } = registration
          const check = () => {
            if (claim.owner !== owner) throw new Error(staleTarget)
            this.assertCurrentOpenTarget(registration, visibilityVersion, deadline)
          }
          if (claim.owner !== owner) throw new Error(staleTarget)
          clearInterval(interval)
          clearTimeout(timeout)
          void this.enqueue(guest, async () => {
            check()
            await waitForMainFrameLoad(guest, url, requestedAt, deadline, () => this.loadResults.get(guest))
            check()
            return { url: guest.getURL() }
          }).then(
            resolve,
            reject,
          )
        } catch (error) {
          if (error instanceof Error && error.message === noTarget) return
          clearInterval(interval)
          clearTimeout(timeout)
          reject(error)
        }
      }, 50)
      this.requestOpen(sessionID, url, requestID)
    }).finally(() => this.openClaims.delete(requestID))
  }

  private resolve(sessionID: string): Registration {
    const matches = [...this.registrations.values()].filter((registration) => {
      if (registration.sessionId !== sessionID || registration.owner.isDestroyed() || registration.guest.isDestroyed()) return false
      if (registration.guest.hostWebContents !== registration.owner
        || this.observedGuests.get(registration.guest.id) !== registration.owner.id
        || this.electronApi.fromId(registration.guest.id) !== registration.guest) return false
      const window = this.electronApi.fromWebContents(registration.owner)
      return Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized())
    })
    if (matches.length === 0) throw new Error(noTarget)
    if (matches.length > 1) throw new Error("Multiple visible browser targets exist for this session")
    return matches[0]
  }

  private assertCurrentOpenTarget(registration: Registration, visibilityVersion: number, deadline: number): void {
    ensureDeadline(deadline)
    if (this.resolveWitness(registration.sessionId) !== registration
      || registration.visibilityVersion !== visibilityVersion) throw new Error(staleTarget)
  }

  private resolveWitness(sessionID: string, target?: string): Registration {
    try {
      const registration = this.resolve(sessionID)
      if (target !== undefined && (target !== this.pageGeneration(registration)
        || !this.documentWatches.has(registration.guest) || !registration.guest.debugger.isAttached())) throw new Error(staleTarget)
      return registration
    } catch (error) {
      if (error instanceof Error && error.message === noTarget) throw new Error(staleTarget)
      throw error
    }
  }

  // Only handleNativeBrowserRequest (the private backend transport) calls this.
  async page(method: string, input: Record<string, unknown>, deadline: number): Promise<unknown> {
    pageEnvelope(method, input)
    const { sessionID, operationID } = input
    if (!validId(sessionID, 256) || typeof operationID !== "string"
      || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(operationID)) {
      throw new Error("Invalid browser page identity")
    }
    if (method === "browser.page.end") {
      const lease = this.pageLeases.get(operationID)
      if (lease?.sessionID === sessionID) this.releaseLease(lease)
      return {}
    }
    ensureDeadline(deadline)
    if (method === "browser.page.begin") {
      const target = requireWitness(input.target)
      const registration = this.resolveWitness(sessionID, target)
      for (const lease of this.pageLeases.values()) if (lease.expires <= Date.now()) this.releaseLease(lease)
      if (this.pageLeases.has(operationID)) throw new Error("Browser page operation already exists")
      if ([...this.pageLeases.values()].some(lease => lease.registration.guest === registration.guest)) {
        throw new Error("Browser page target is busy")
      }
      if (this.pageLeases.size >= 32) throw new Error("Too many browser page operations")
      const expires = Date.now() + 30_000
      const lease: PageLease = {
        sessionID, operationID, registration, generation: this.pageGeneration(registration), expires,
        timer: setTimeout(() => this.releaseLease(lease), 30_000),
      }
      lease.timer.unref()
      this.pageLeases.set(operationID, lease)
      try {
        return await this.enqueue(registration.guest, async () => {
          const check = () => this.resolveWitness(sessionID, target)
          await this.refreshDocument(registration.guest, Math.min(deadline, lease.expires), check)
          check()
          const url = this.checkLease(lease, deadline)
          return { generation: lease.generation, url, driver: "cdp", contractVersion: PAGE_DRIVER_VERSION }
        })
      } catch (error) {
        this.releaseLease(lease)
        throw error
      }
    }
    if (method !== "browser.page.send" && method !== "browser.page.check") throw new Error("Invalid browser page method")
    const lease = this.pageLeases.get(operationID)
    if (!lease || lease.sessionID !== sessionID || lease.generation !== input.generation) {
      throw new Error("Browser page lease is no longer current")
    }
    const operation = method === "browser.page.send" ? parsePageOperation(input.operation) : undefined
    const { guest } = lease.registration
    const check = () => this.checkLease(lease, deadline)
    const stopAt = Math.min(deadline, lease.expires)
    return this.enqueue(guest, async () => {
      try {
        await this.refreshDocument(guest, stopAt, check)
        if (!operation) return { url: check() }
        const result = await executeCdpOperation({ send: async (command, params = {}) => {
          check()
          // Electron's native insertion reaches the guest's focused frame even
          // when CDP Input.insertText is ignored in an embedded/background view.
          const response = await withDeadline(
            () => command === "Input.insertText" && typeof (params as { text?: unknown }).text === "string"
              ? guest.insertText((params as { text: string }).text).then(() => ({}))
              : command === "Input.dispatchKeyEvent" ? sendGuestKey(guest, params as Record<string, unknown>)
              : guest.debugger.sendCommand(command, params), stopAt,
          )
          check()
          if (Buffer.byteLength(JSON.stringify(response ?? null)) > 4 * 1024 * 1024) throw new Error("Browser page response is too large")
          return response as Record<string, unknown>
        } }, operation)
        await this.refreshDocument(guest, stopAt, check)
        check()
        if (Buffer.byteLength(JSON.stringify(result ?? null)) > 4 * 1024 * 1024) throw new Error("Browser page response is too large")
        return result
      } catch (error) {
        this.releaseLease(lease)
        throw error
      }
    })
  }

  private async refreshDocument(guest: WebContents, deadline: number, check: () => void): Promise<void> {
    check()
    // document.open() can replace the root element before Page.documentOpened arrives,
    // while retaining the frame, loader and Document node.
    const result = await withDeadline(() => guest.debugger.sendCommand("DOM.getDocument", { depth: 1 }), deadline) as {
      root?: { children?: Array<{ nodeType: number; backendNodeId: number }> }
    }
    check()
    const root = result.root?.children?.find(node => node.nodeType === 1)?.backendNodeId
    const previous = this.documentRoots.get(guest)
    if (previous !== undefined && previous !== root) {
      this.invalidateDocument(guest)
    }
    if (root === undefined || !Number.isSafeInteger(root) || root <= 0) throw new Error(staleTarget)
    this.documentRoots.set(guest, root)
  }

  private invalidateDocument(guest: WebContents): void {
    this.documentRoots.delete(guest)
    this.navigationVersions.set(guest, (this.navigationVersions.get(guest) ?? 0) + 1)
    this.releaseGuest(guest)
  }

  private pageGeneration(registration: Registration): string {
    return `${registration.generation}:${registration.visibilityVersion}:${this.navigationVersions.get(registration.guest) ?? 0}`
  }

  private checkLease(lease: PageLease, deadline: number): string {
    ensureDeadline(Math.min(deadline, lease.expires))
    const { registration } = lease
    if (this.pageLeases.get(lease.operationID) !== lease || this.resolve(lease.sessionID) !== registration
      || this.pageGeneration(registration) !== lease.generation || !registration.guest.debugger.isAttached()) {
      throw new Error("Browser page lease is no longer current")
    }
    const url = registration.guest.getURL()
    if (!isBrowserUrlAllowed(url)) throw new Error("Browser page URL is unavailable")
    return url
  }

  private releaseGuest(guest: WebContents): void {
    for (const lease of this.pageLeases.values()) if (lease.registration.guest === guest) this.releaseLease(lease)
  }

  private releaseTarget(guest: WebContents): void {
    this.releaseGuest(guest)
    const ownsDebugger = this.documentWatches.get(guest)
    this.documentWatches.delete(guest)
    if (ownsDebugger) this.detachDebugger(guest)
  }

  private releaseLease(lease: PageLease): void {
    if (this.pageLeases.get(lease.operationID) !== lease) return
    this.pageLeases.delete(lease.operationID)
    clearTimeout(lease.timer)
  }

  private detachDebugger(guest: WebContents): void {
    if (guest.isDestroyed()) return
    this.controlledDetach.add(guest)
    try { if (guest.debugger.isAttached()) guest.debugger.detach() } catch { /* already disposed */ }
    finally { this.controlledDetach.delete(guest) }
  }

  private enqueue<T>(guest: WebContents, operation: () => Promise<T>): Promise<T> {
    const result = (this.commandQueues.get(guest) ?? Promise.resolve()).then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.commandQueues.set(guest, tail)
    void tail.then(() => {
      if (this.commandQueues.get(guest) === tail) this.commandQueues.delete(guest)
    })
    return result
  }
}

export async function handleNativeBrowserRequest(controller: BrowserController, method: string, params: unknown, deadline = Number.POSITIVE_INFINITY): Promise<unknown> {
  const input = params as { sessionID?: unknown; command?: unknown; target?: unknown } | undefined
  if (!input || typeof input.sessionID !== "string") throw new Error("Invalid browser request")
  if (method === "browser.probe") return controller.probe(input.sessionID, deadline)
  if (["browser.page.begin", "browser.page.send", "browser.page.check", "browser.page.end"].includes(method)) {
    return controller.page(method, input as Record<string, unknown>, deadline)
  }
  if (method === "browser.execute" && input.command && typeof input.command === "object") {
    return controller.execute(input.sessionID, input.command as BrowserCommand, deadline, input.target)
  }
  throw new Error(`Unsupported native method: ${method}`)
}

function ensureDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new Error("Native request expired before execution")
}

async function sendGuestKey(guest: WebContents, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const aliases: Record<string, string> = { ArrowDown: "Down", ArrowUp: "Up", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space" }
  if (typeof params.key !== "string" || !["keyDown", "rawKeyDown", "keyUp"].includes(String(params.type))) throw new Error("Invalid browser key event")
  if (params.key === "ContextMenu") throw new Error("Electron native input does not support ContextMenu; use Shift+F10")
  const mask = typeof params.modifiers === "number" ? params.modifiers : 0
  const modifiers = [[1, "alt"], [2, "control"], [4, "meta"], [8, "shift"]] as const
  const options = { keyCode: aliases[params.key] ?? params.key, modifiers: modifiers.filter(([bit]) => mask & bit).map(([, name]) => name) }
  guest.sendInputEvent({ type: params.type === "keyUp" ? "keyUp" : "keyDown", ...options })
  if (params.type === "keyDown" && typeof params.text === "string" && params.text) guest.sendInputEvent({ type: "char", ...options, keyCode: params.text })
  return {}
}

function validId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

async function withDebugger<T>(guest: WebContents, deadline: number, detach: () => void, operation: (debuggerSession: Pick<WebContents["debugger"], "sendCommand">) => Promise<T>): Promise<T> {
  const attached = guest.debugger.isAttached()
  if (!attached) guest.debugger.attach("1.3")
  const debuggerSession = {
    sendCommand: (...args: Parameters<WebContents["debugger"]["sendCommand"]>) => {
      // A pending protocol reply can outlive the request deadline. Fence its
      // continuation without detaching someone else's persistent overrides.
      ensureDeadline(deadline)
      return guest.debugger.sendCommand(...args)
    },
  }
  try {
    return await withDeadline(() => operation(debuggerSession), deadline, attached ? undefined : detach)
  } finally {
    if (!attached) detach()
  }
}

async function withDeadline<T>(operation: () => Promise<T>, deadline: number, onTimeout?: () => void): Promise<T> {
  if (!Number.isFinite(deadline)) return operation()
  ensureDeadline(deadline)
  let timeout: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      try {
        onTimeout?.()
      } finally {
        reject(new Error("Native browser command timed out"))
      }
    }, Math.max(1, deadline - Date.now()))
  })
  try {
    return await Promise.race([operation(), expired])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function waitForMainFrameLoad(
  guest: WebContents,
  expectedUrl: string,
  requestedAt: number,
  deadline: number,
  loadResult: () => { at: number; url: string; startedUrl: string; error?: Error } | undefined,
): Promise<void> {
  const expected = new URL(expectedUrl).href
  const completed = loadResult()
  if (completed && completed.at >= requestedAt && matchesLoad(completed, expected)) {
    if (completed.error) throw completed.error
    return
  }
  if (!guest.isLoading() && guest.getURL() === expected) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      guest.removeListener("did-finish-load", finish)
      guest.removeListener("did-fail-load", fail)
    }
    const finish = () => {
      const result = loadResult()
      if (!result || !matchesLoad(result, expected)) return
      cleanup()
      if (result.error) reject(result.error)
      else resolve()
    }
    const fail = (_event: Electron.Event, code: number, _description: string, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame || code === -3) return
      finish()
    }
    const timeoutMs = Math.min(10_000, Math.max(1, deadline - Date.now()))
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(Date.now() >= deadline ? "Native request expired before execution" : "Timed out waiting for the browser page to load"))
    }, timeoutMs)
    guest.once("did-finish-load", finish)
    guest.on("did-fail-load", fail)
  })
}

function matchesLoad(result: { url: string; startedUrl: string }, expected: string): boolean {
  return new URL(result.url).href === expected || new URL(result.startedUrl).href === expected
}
