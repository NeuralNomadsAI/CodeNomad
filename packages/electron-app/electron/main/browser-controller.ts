import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import type { BrowserWindow, WebContents } from "electron"
import { isBrowserUrlAllowed } from "./browser-webview-security"
import { setBrowserEmulation } from "./browser-emulation"
import { executeCdpOperation } from "../../../server/src/automation/page/cdp-driver"
import { parsePageOperation, pageEnvelope } from "../../../server/src/automation/page/operations"
import { DIAGNOSTICS, DiagnosticEventBuffer } from "../../../server/src/automation/page/diagnostic-events"
import { PAGE_DRIVER_VERSION } from "../../../server/src/automation/page/protocol"
import { setBrowserLogicalAddress } from "./browser-presentation"
import { BrowserPreviewOwners, type PreviewOwner } from "./browser-preview-owners"

const electron = () => createRequire(import.meta.url)("electron") as typeof import("electron")

interface BrowserControllerElectron {
  fromId(id: number): WebContents | undefined | null
  fromWebContents(contents: WebContents): BrowserWindow | null
}

interface RegistrationInput {
  logicalAddress?: string
  instanceId?: string
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
  owner: WebContents
  frame: WebContents["mainFrame"]
  deadline: number
  attachDeadline: number
  checkAdmission: () => void
  workspaceIDs: readonly string[]
  instanceId?: string
  ownership?: PreviewOwner<WebContents>
  target?: Registration
  dispatched?: boolean
  retirement: AbortController
  discovery?: { resolve: (result: string | null) => void; reject: (error: Error) => void }
}

type BrowserCommand =
  | { action: "open"; url: string }
  | { action: "navigate"; url: string }
  | { action: "back" | "forward" | "reload" }
  | { action: "screenshot" }

const noTarget = "No visible local browser target for this session"
const staleTarget = "Browser target is stale; probe again"

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
  private readonly retainedSessions = new Map<WebContents, string>()
  private readonly observedGuests = new Map<number, number>()
  private readonly pageLeases = new Map<string, PageLease>()
  private readonly controlledDetach = new WeakSet<WebContents>()
  private readonly documentWatches = new WeakMap<WebContents, boolean>()
  /** Console and network events of a watched preview's current document. */
  private readonly diagnostics = new WeakMap<WebContents, DiagnosticEventBuffer>()
  private readonly recording = new WeakSet<WebContents>()
  private readonly commandQueues = new WeakMap<WebContents, Promise<void>>()
  private readonly navigationVersions = new WeakMap<WebContents, number>()
  private readonly documentRoots = new WeakMap<WebContents, number>()
  private readonly openClaims = new Map<string, OpenClaim>()
  private readonly attaching = new WeakMap<WebContents, string>()
  private readonly previewOwners = new BrowserPreviewOwners<WebContents>()
  private readonly ownerWindows = new Set<WebContents>()

  constructor(
    private readonly openCandidates: () => readonly WebContents[],
    private readonly electronApi: BrowserControllerElectron = {
      fromId: (id) => electron().webContents.fromId(id),
      fromWebContents: (contents) => electron().BrowserWindow.fromWebContents(contents),
    },
  ) {}

  private publishOwnership(sessionId: string, revision: number, owner?: PreviewOwner<WebContents>) {
    for (const window of this.ownerWindows) {
      if (!window.isDestroyed() && window !== owner?.window) window.send("browser-target:ownership", this.ownership(sessionId, revision, window, owner))
    }
  }

  private ownership(sessionId: string, revision: number, requester: WebContents, owner?: PreviewOwner<WebContents>) {
    return { sessionId, revision, owner: owner ? { instanceId: owner.instanceId, sameWindow: owner.window === requester } : null }
  }

  changeOwnership(window: WebContents, input: unknown) {
    const { action, sessionId, instanceId, revision, requestID } = (input ?? {}) as Record<string, unknown>
    if (!validId(instanceId, 256)) throw new Error("Invalid browser occurrence")
    if (action === "release") {
      for (const entry of this.previewOwners.release(window, instanceId)) {
        for (const [guest, session] of this.retainedSessions) {
          if (session !== entry.sessionId || guest.isDestroyed() || guest.hostWebContents !== window) continue
          this.releaseTarget(guest)
          this.retainedSessions.delete(guest)
          guest.close()
        }
        this.publishOwnership(entry.sessionId, entry.revision)
      }
      return
    }
    if (!validId(sessionId, 256)) throw new Error("Invalid browser session")
    if (action === "ready") {
      if (typeof requestID !== "string") return
      const claim = this.openClaims.get(requestID)
      if (!claim || claim.owner !== window || claim.sessionID !== sessionId || claim.instanceId !== instanceId
        || !this.openClaimCurrent(requestID, claim)) return
      const snapshot = this.grantOwnership(sessionId, window, instanceId)
      if (snapshot.owner?.sameWindow && snapshot.owner.instanceId === instanceId) claim.ownership = this.previewOwners.get(sessionId)
      return snapshot
    }
    if (action === "used") { this.previewOwners.used(sessionId, window, instanceId); return }
    if (action === "focus") {
      const owner = this.previewOwners.get(sessionId)
      if (!owner || owner.revision !== revision || owner.window.isDestroyed()) return
      const target = this.electronApi.fromWebContents(owner.window)
      if (!target || target.isDestroyed()) return
      if (target.isMinimized()) target.restore()
      if (!target.isVisible()) target.show()
      target.focus()
      owner.window.send("browser-target:focus-owner", { sessionId, instanceId: owner.instanceId })
      return
    }
    if (action !== "request") throw new Error("Invalid browser ownership action")
    return this.grantOwnership(sessionId, window, instanceId, typeof revision === "number" ? revision : undefined)
  }

  private grantOwnership(sessionId: string, window: WebContents, instanceId: string, revision?: number) {
    const before = this.previewOwners.get(sessionId)
    const { owner, previous } = this.previewOwners.request(sessionId, window, instanceId, revision)
    if (previous) {
      for (const registration of this.registrations.values()) {
        if (registration.owner !== window || registration.sessionId !== sessionId) continue
        this.releaseTarget(registration.guest)
        // The live guest stays in this window. Its old automation witness does not.
        this.registrations.delete(registration.registrationId)
      }
    }
    if (before !== owner) this.publishOwnership(sessionId, owner.revision, owner)
    return this.ownership(sessionId, owner.revision, window, owner)
  }

  permitOpenAttachment(owner: WebContents, params: Record<string, string>): boolean {
    const marker = /^codenomadPreview=(\d+)$/.exec(params.webpreferences ?? "")
    if (!marker) return params.src !== "about:blank"
    const session = this.previewOwners.sessionFor(owner, Number(marker[1]))
    if (!session || this.attaching.has(owner) || [...this.retainedSessions].some(([guest, id]) => id === session && !guest.isDestroyed())) return false
    this.attaching.set(owner, session)
    // Native guest construction consumes the permit synchronously; never lend
    // an unconsumed permit to a later webview from the same renderer.
    queueMicrotask(() => {
      if (this.attaching.get(owner) === session) this.attaching.delete(owner)
    })
    return true
  }

  guestCreated(guest: WebContents): void {
    if (guest.getType() !== "webview") return
    // Before the first page loads, so its own requests and startup console output are kept.
    try { if (!guest.debugger.isAttached()) guest.debugger.attach("1.3") } catch { /* diagnostics start with the document watch */ }
    if (guest.debugger.isAttached()) {
      // Page events too, so a document.open() before the first probe still restarts the diagnostics.
      void guest.debugger.sendCommand("Page.enable").catch(() => undefined)
      void this.enableDiagnostics(guest, Number.POSITIVE_INFINITY)
    }
    const owner = guest.hostWebContents
    const session = owner && this.attaching.get(owner)
    if (!session || !owner) return
    this.attaching.delete(owner)
    this.retainedSessions.set(guest, session)
    guest.once("destroyed", () => this.retainedSessions.delete(guest))
  }

  observeGuest(owner: WebContents, guest: WebContents): void {
    this.observedGuests.set(guest.id, owner.id)
    this.navigationVersions.set(guest, 0)
    const invalidate = () => this.invalidateDocument(guest)
    const invalidateNavigation = () => {
      invalidate()
      for (const [id, claim] of this.openClaims) {
        if (claim.target?.guest === guest && !claim.dispatched) this.releaseOpen(claim.owner, id, undefined, true)
      }
    }
    guest.on("did-navigate", invalidateNavigation)
    guest.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) invalidateNavigation()
    })
    guest.on("did-frame-navigate", (_event, _url, _code, _status, isMainFrame) => {
      if (isMainFrame) invalidate()
    })
    guest.on("render-process-gone", () => {
      invalidate()
      this.releaseTarget(guest)
    })
    guest.debugger.on("message", (_event, method, params, sessionId) => {
      if (!sessionId && method === "Page.documentOpened" && params?.frame?.id && !params.frame.parentId) {
        // document.open() replaces the document without a navigation: its diagnostics restart too.
        this.diagnostics.get(guest)?.restart()
        invalidate()
      }
    })
    guest.debugger.on("detach", () => {
      this.documentWatches.delete(guest)
      this.diagnostics.delete(guest)
      if (!this.controlledDetach.has(guest)) invalidate()
    })
    guest.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      // A new document's diagnostics start with its own request, as in OpenCode's browser.
      if (isMainFrame && !isInPlace) this.diagnostics.get(guest)?.restart()
      if (isMainFrame) invalidateNavigation()
    })
    guest.once("destroyed", () => {
      this.observedGuests.delete(guest.id)
      this.documentWatches.delete(guest)
      this.documentRoots.delete(guest)
      this.retainedSessions.delete(guest)
      this.releaseGuest(guest)
      for (const [id, registration] of this.registrations) {
        if (registration.guest.id === guest.id) this.registrations.delete(id)
      }
    })
  }

  register(owner: WebContents, input: RegistrationInput): void {
    if (!validId(input.sessionId, 256) || !validId(input.registrationId, 128)
      || (input.instanceId !== undefined && !validId(input.instanceId, 256)) || !Number.isInteger(input.guestWebContentsId)) {
      throw new Error("Invalid browser target registration")
    }
    const guest = this.electronApi.fromId(input.guestWebContentsId)
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview"
      || guest.hostWebContents !== owner || this.observedGuests.get(guest.id) !== owner.id) {
      throw new Error("Browser guest does not belong to this window")
    }
    const previous = this.registrations.get(input.registrationId)
    if (previous && previous.owner !== owner) throw new Error("Browser target belongs to another window")
    setBrowserLogicalAddress(guest, input.logicalAddress)
    if (previous) this.releaseTarget(previous.guest)
    if (input.instanceId) {
      const expected = this.previewOwners.get(input.sessionId)
      if (expected?.window !== owner || expected.instanceId !== input.instanceId) {
        throw new Error("Browser preview belongs to another tab")
      }
      if ([...this.retainedSessions].some(([existing, session]) => session === input.sessionId && existing !== guest && !existing.isDestroyed())) {
        throw new Error("This session already has a native preview")
      }
      this.retainedSessions.set(guest, input.sessionId)
    }
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

  claimOpen(owner: WebContents, requestID: unknown, response: unknown): boolean {
    if (typeof requestID !== "string" || !response || typeof response !== "object") return false
    const claim = this.openClaims.get(requestID)
    if (!claim || claim.owner !== owner || !this.openClaimCurrent(requestID, claim)) return false
    const { kind, instanceId, registrationId } = response as Record<string, unknown>
    if (kind === "discover" && claim.discovery && (instanceId === null
      || (typeof instanceId === "string" && claim.workspaceIDs.includes(instanceId)))) {
      const { resolve } = claim.discovery
      claim.discovery = undefined
      resolve(instanceId as string | null)
      return true
    }
    if (!claim.ownership || instanceId !== claim.ownership.instanceId) return false
    if (kind === "target" && !claim.target && typeof registrationId === "string") {
      const registration = this.registrations.get(registrationId)
      if (registration?.owner !== owner || registration.sessionId !== claim.sessionID || registration.instanceId !== instanceId
        || !this.registrationVisible(registration)) return false
      claim.target = registration
      return true
    }
    return false
  }

  private openClaimCurrent(requestID: string, claim: OpenClaim): boolean {
    try { claim.checkAdmission() } catch { return false }
    return this.openClaims.get(requestID) === claim && this.openWindowVisible(claim.owner)
      && (!claim.ownership || this.previewOwners.get(claim.sessionID) === claim.ownership)
      && claim.owner.mainFrame === claim.frame && Date.now() < (claim.target ? claim.deadline : claim.attachDeadline)
  }

  releaseOpen(owner: WebContents, requestID: unknown, committedUrl?: string, keepGuest?: boolean, successorUrl?: string): boolean {
    if (typeof requestID !== "string") return false
    const claim = this.openClaims.get(requestID)
    if (!claim || claim.owner !== owner) return false
    const preserveGuest = keepGuest && claim.target && this.registrations.get(claim.target.registrationId) === claim.target
      && this.registrationVisible(claim.target)
    claim.discovery?.reject(new Error("Browser open target changed"))
    this.openClaims.delete(requestID)
    claim.retirement.abort(new Error("Browser open target changed"))
    if (claim.instanceId && !owner.isDestroyed() && owner.mainFrame === claim.frame) {
      owner.send("browser-target:open-settled", { requestID, sessionID: claim.sessionID, instanceId: claim.instanceId, committedUrl,
        ...(preserveGuest && { keepGuest: true, ...(successorUrl && { successorUrl }) }) })
    }
    return !keepGuest || Boolean(preserveGuest)
  }

  observeOwner(window: BrowserWindow): void {
    // BrowserWindow's native getters throw once "closed" is emitted. Retain
    // the owner identity while it is alive; cleanup only compares references.
    const owner = window.webContents
    this.ownerWindows.add(owner)
    window.once("closed", () => { this.ownerWindows.delete(owner); this.removeOwner(owner) })
    owner.on?.("did-start-navigation", (_event, _url, sameDocument, mainFrame) => {
      if (mainFrame && !sameDocument) this.removeOwner(owner)
    })
    const revokeVisibility = () => {
      for (const registration of this.registrations.values()) {
        if (registration.owner !== owner) continue
        registration.visibilityVersion++
        this.releaseTarget(registration.guest)
      }
      this.releaseOwnerOpens(owner)
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
    this.releaseOwnerOpens(owner)
    for (const entry of this.previewOwners.release(owner)) this.publishOwnership(entry.sessionId, entry.revision)
  }

  private releaseOwnerOpens(owner: WebContents): void {
    for (const [requestID, claim] of this.openClaims) if (claim.owner === owner) this.releaseOpen(owner, requestID)
  }

  /** Keeps the guest's console and network events from now on. Diagnostics are an extra: a preview whose
   * domains cannot be enabled still serves the page channel. */
  private async enableDiagnostics(guest: WebContents, deadline: number): Promise<void> {
    if (this.diagnostics.has(guest)) return
    const buffer = new DiagnosticEventBuffer()
    this.diagnostics.set(guest, buffer)
    if (!this.recording.has(guest)) {
      this.recording.add(guest)
      guest.debugger.on("message", (_event, method, params, sessionId) => {
        if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") this.startChild(guest, params)
        this.diagnostics.get(guest)?.record(method, params, sessionId || undefined)
      })
    }
    try {
      // Sent together, so the domains are on before the guest's first request.
      await Promise.all(DIAGNOSTICS.enable.map(([method, params]) => withDeadline(() => guest.debugger.sendCommand(method, params), deadline)))
    } catch {
      if (this.diagnostics.get(guest) === buffer) this.diagnostics.delete(guest)
    }
  }

  /** A child target paused at start by the auto-attach, as in OpenCode's browser: a worker runs and is left; a page
   * frame gets the diagnostic domains first; an extension frame only runs. Every one is resumed, even when its
   * domains fail or diagnostics are off, so no frame or worker stays paused. */
  private startChild(guest: WebContents, params: { sessionId: string; targetInfo?: { type?: unknown; url?: unknown } }): void {
    const session = params.sessionId
    const send = (method: string, options: Record<string, unknown> = {}) => guest.debugger.sendCommand(method, options, session)
    const resume = () => send("Runtime.runIfWaitingForDebugger")
    const type = params.targetInfo?.type
    const extension = /^[a-z-]*extension:/i.test(String(params.targetInfo?.url ?? ""))
    const started = type === "worker"
      ? resume().then(() => guest.debugger.sendCommand("Target.detachFromTarget", { sessionId: session }))
      : type === "iframe" && !extension && this.diagnostics.has(guest)
        ? Promise.allSettled(DIAGNOSTICS.enable.map(([method, options]) => send(method, options))).then(resume)
        : resume()
    void started.catch(() => undefined)
  }

  /** Observes the renderer even between page leases, with the console and network domains of its diagnostics. */
  private async watchDocument(guest: WebContents, deadline: number, check: () => void): Promise<void> {
    if (this.documentWatches.has(guest)) return
    const ownsDebugger = !guest.debugger.isAttached()
    if (ownsDebugger) guest.debugger.attach("1.3")
    try {
      await withDeadline(() => guest.debugger.sendCommand("Page.enable"), deadline)
      check()
      if (!guest.debugger.isAttached()) throw new Error(staleTarget)
      this.documentWatches.set(guest, ownsDebugger)
      await this.enableDiagnostics(guest, deadline)
      check()
    } catch (error) {
      if (ownsDebugger) this.detachDebugger(guest)
      throw error
    }
  }

  /** `workspaceIDs` are the project tabs whose views may serve the session: another tab's preview is no target. */
  async probe(sessionID: string, deadline = Number.POSITIVE_INFINITY, checkAdmission: () => void = () => {},
    workspaceIDs?: readonly string[]): Promise<{ available: true; target: string; loading: boolean; registration: string }> {
    ensureDeadline(deadline)
    checkAdmission()
    const registration = this.resolve(sessionID, workspaceIDs)
    const { guest } = registration
    const generation = this.pageGeneration(registration)
    const target = await this.enqueue(guest, async () => {
      const check = () => {
        ensureDeadline(deadline)
        checkAdmission()
        if (this.resolveWitness(sessionID, undefined, workspaceIDs) !== registration || this.pageGeneration(registration) !== generation) throw new Error(staleTarget)
      }
      check()
      await this.watchDocument(guest, deadline, check)
      await this.refreshDocument(guest, deadline, check)
      return this.pageGeneration(registration)
    }, deadline)
    ensureDeadline(deadline)
    checkAdmission()
    this.resolveWitness(sessionID, target)
    return { available: true, target, loading: guest.isLoading(), registration: registration.generation }
  }

  async execute(sessionID: string, command: Exclude<BrowserCommand, { action: "open" }>, deadline = Number.POSITIVE_INFINITY, target?: unknown, checkAdmission: () => void = () => {}): Promise<unknown> {
    if (!["navigate", "back", "forward", "reload", "screenshot"].includes(command.action)) throw new Error("Invalid browser command")
    const registration = this.resolveWitness(sessionID, requireWitness(target))
    const { guest, visibilityVersion } = registration
    const document = this.pageGeneration(registration)
    const check = (exactDocument: boolean) => {
      ensureDeadline(deadline)
      checkAdmission()
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
          return { ...await loadNavigation(guest, command.url, deadline, () => check(false)), registration: registration.generation }
        }
        case "back":
        case "forward": {
          const history = await withDeadline(() => guest.debugger.sendCommand("Page.getNavigationHistory"), deadline) as {
            currentIndex?: number
            entries?: Array<{ id: number; url: string }>
          }
          checkDocument()
          const index = typeof history.currentIndex === "number" ? history.currentIndex : -1
          const entries = Array.isArray(history.entries) ? history.entries : []
          const next = entries[command.action === "back" ? index - 1 : index + 1]
          if (!next) throw new Error(command.action === "back" ? "No previous page in browser history" : "No next page in browser history")
          if (!isBrowserUrlAllowed(next.url)) throw new Error("Browser history entry requires a credential-free HTTP(S) URL")
          return { registration: registration.generation, ...await loadTriggeredNavigation(guest, next.url, deadline, () => check(false),
            () => guest.debugger.sendCommand("Page.navigateToHistoryEntry", { entryId: next.id }).then(() => undefined)) }
        }
        case "reload": {
          const currentUrl = guest.getURL()
          if (!isBrowserUrlAllowed(currentUrl)) throw new Error("Browser reload requires a credential-free HTTP(S) URL")
          return { registration: registration.generation, ...await loadTriggeredNavigation(guest, currentUrl, deadline, () => check(false),
            () => guest.debugger.sendCommand("Page.reload", {}).then(() => undefined)) }
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
    }, deadline)
  }

  async open(sessionID: string, url: string, deadline: number, workspaceIDs: readonly string[], checkAdmission: () => void = () => {}): Promise<{ url: string; registration?: string }> {
    if (!isBrowserUrlAllowed(url)) throw new Error("Browser navigation requires a credential-free HTTP(S) URL")
    const registrationDeadline = Math.min(deadline, Date.now() + 10_000)
    const existingOwner = this.previewOwners.get(sessionID)
    if (existingOwner && (!workspaceIDs.includes(existingOwner.instanceId) || !this.openWindowVisible(existingOwner.window))) {
      throw new Error("The owning preview tab is unavailable")
    }
    const preferred = existingOwner ?? this.previewOwners.lastUsed(sessionID, (window, instanceId) =>
      workspaceIDs.includes(instanceId) && this.openWindowVisible(window))
    for (const owner of preferred ? [preferred.window] : this.openCandidates()) {
      if (!this.openWindowVisible(owner)) continue
      ensureDeadline(registrationDeadline)
      const requestID = randomUUID()
      const claim: OpenClaim = { owner, frame: owner.mainFrame, sessionID, deadline, attachDeadline: registrationDeadline,
        workspaceIDs, checkAdmission, retirement: new AbortController() }
      const check = () => {
        if (!this.openClaimCurrent(requestID, claim)) throw new Error("Browser open target changed or timed out")
      }
      this.openClaims.set(requestID, claim)
      try {
        check()
        const occurrence = preferred?.instanceId ?? await withDeadline(() => new Promise<string | null>((resolve, reject) => {
          claim.discovery = { resolve, reject }
          owner.send("browser-target:discover", { requestID, sessionID, workspaceIDs })
          // Navigation, closure or hide retires this read without trying another window.
          if (!this.openClaimCurrent(requestID, claim)) reject(new Error("Browser open target changed"))
        }), registrationDeadline)
        check()
        if (occurrence === null) continue
        const actual = this.previewOwners.get(sessionID)
        if (actual && (actual.window !== owner || actual.instanceId !== occurrence)) {
          return this.open(sessionID, url, deadline, workspaceIDs, checkAdmission)
        }
        claim.instanceId = occurrence
        owner.send("browser-target:open", { sessionID, requestID, instanceId: occurrence, url })
        for (;;) {
          check()
          if (claim.target) {
            const expected = claim.target
            const checkRegistration = () => {
              check()
              if (this.registrations.get(expected.registrationId) !== expected || !this.registrationVisible(expected)) {
                throw new Error("Browser open registration changed")
              }
            }
            const { guest } = expected
            return await this.enqueue(guest, async () => {
              checkRegistration()
              claim.dispatched = true
              // A fragment-only open keeps the document: restarting here drops old-page events fired before dispatch.
              this.diagnostics.get(guest)?.restart()
              const committed = await loadNavigation(guest, url, deadline, checkRegistration).catch(error => {
                if (error instanceof MainNavigationSuperseded) this.releaseOpen(owner, requestID, undefined, true, error.successorUrl)
                throw error
              })
              checkRegistration()
              this.releaseOpen(owner, requestID, committed.url)
              return { ...committed, registration: expected.generation }
            }, deadline, claim.retirement.signal)
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      } finally {
        this.releaseOpen(owner, requestID)
      }
    }
    throw new Error("No visible local window has the owning project tab")
  }

  private openWindowVisible(owner: WebContents): boolean {
    if (owner.isDestroyed()) return false
    const window = this.electronApi.fromWebContents(owner)
    return Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized())
  }

  private registrationVisible({ guest, owner }: Registration): boolean {
    return !guest.isDestroyed() && guest.hostWebContents === owner
      && this.observedGuests.get(guest.id) === owner.id && this.electronApi.fromId(guest.id) === guest
      && this.openWindowVisible(owner)
  }

  private resolve(sessionID: string, workspaceIDs?: readonly string[]): Registration {
    const matches = [...this.registrations.values()].filter(registration => registration.sessionId === sessionID && this.registrationVisible(registration)
      && (!workspaceIDs || (registration.instanceId !== undefined && workspaceIDs.includes(registration.instanceId))))
    if (matches.length === 0) throw new Error(noTarget)
    if (matches.length > 1) throw new Error("Multiple visible browser targets exist for this session")
    return matches[0]
  }

  private resolveWitness(sessionID: string, target?: string, workspaceIDs?: readonly string[]): Registration {
    try {
      const registration = this.resolve(sessionID, workspaceIDs)
      if (target !== undefined && (target !== this.pageGeneration(registration)
        || !this.documentWatches.has(registration.guest) || !registration.guest.debugger.isAttached())) throw new Error(staleTarget)
      return registration
    } catch (error) {
      if (error instanceof Error && error.message === noTarget) throw new Error(staleTarget)
      throw error
    }
  }

  // Only handleNativeBrowserRequest (the private backend transport) calls this.
  async page(method: string, input: Record<string, unknown>, deadline: number, checkAdmission: () => void = () => {}): Promise<unknown> {
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
    checkAdmission()
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
          const check = () => {
            checkAdmission()
            this.resolveWitness(sessionID, target)
          }
          await this.refreshDocument(registration.guest, Math.min(deadline, lease.expires), check)
          check()
          // Agent page operations never open a native file picker on the person's screen.
          const intercept = (params: Record<string, unknown>) => withDeadline(
            () => registration.guest.debugger.sendCommand("Page.setInterceptFileChooserDialog", params), Math.min(deadline, lease.expires))
          await intercept({ enabled: true, cancel: true }).catch(() => intercept({ enabled: true }))
          check()
          const url = this.checkLease(lease, deadline, checkAdmission)
          return { generation: lease.generation, url, driver: "cdp", contractVersion: PAGE_DRIVER_VERSION }
        }, deadline)
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
    const check = () => this.checkLease(lease, deadline, checkAdmission)
    const stopAt = Math.min(deadline, lease.expires)
    return this.enqueue(guest, async () => {
      try {
        await this.refreshDocument(guest, stopAt, check)
        if (!operation) return { url: check() }
        const result = await executeCdpOperation({ send: async (command, params = {}, sessionId) => {
          check()
          // Electron's native insertion reaches the guest's focused frame even
          // when CDP Input.insertText is ignored in an embedded/background view.
          const response = await withDeadline(
            () => command === "Input.insertText" && typeof (params as { text?: unknown }).text === "string"
              ? guest.insertText((params as { text: string }).text).then(() => ({}))
              : command === "Input.dispatchKeyEvent" ? sendGuestKey(guest, params as Record<string, unknown>)
              : guest.debugger.sendCommand(command, params, sessionId), stopAt,
          )
          check()
          if (Buffer.byteLength(JSON.stringify(response ?? null)) > 4 * 1024 * 1024) throw new Error("Browser page response is too large")
          return response as Record<string, unknown>
        }, diagnostics: async after => {
          check()
          const buffer = this.diagnostics.get(guest)
          if (!buffer) throw new Error("Browser diagnostics are unavailable for this preview")
          return buffer.read(after) as unknown as Record<string, unknown>
        } }, operation)
        await this.refreshDocument(guest, stopAt, check)
        check()
        if (Buffer.byteLength(JSON.stringify(result ?? null)) > 4 * 1024 * 1024) throw new Error("Browser page response is too large")
        return result
      } catch (error) {
        this.releaseLease(lease)
        throw error
      }
    }, stopAt)
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

  private checkLease(lease: PageLease, deadline: number, checkAdmission: () => void): string {
    ensureDeadline(Math.min(deadline, lease.expires))
    const { registration } = lease
    checkAdmission()
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
    const { guest } = lease.registration
    if (!guest.isDestroyed() && guest.debugger.isAttached())
      void guest.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined)
  }

  private detachDebugger(guest: WebContents): void {
    if (guest.isDestroyed()) return
    this.controlledDetach.add(guest)
    try { if (guest.debugger.isAttached()) guest.debugger.detach() } catch { /* already disposed */ }
    finally { this.controlledDetach.delete(guest) }
  }

  private async enqueue<T>(guest: WebContents, operation: () => Promise<T>, deadline = Number.POSITIVE_INFINITY, signal?: AbortSignal): Promise<T> {
    let admit!: () => void
    const admission = new Promise<void>(resolve => { admit = resolve })
    const result = (this.commandQueues.get(guest) ?? Promise.resolve()).then(() => {
      admit()
      ensureDeadline(deadline)
      signal?.throwIfAborted()
      return operation()
    })
    const tail = result.then(() => undefined, () => undefined)
    this.commandQueues.set(guest, tail)
    void tail.then(() => {
      if (this.commandQueues.get(guest) === tail) this.commandQueues.delete(guest)
    })
    // Bound the wait for the slot, not the admitted operation's cleanup.
    if (signal) {
      let onAbort!: () => void
      const retired = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason) })
      signal.addEventListener("abort", onAbort, { once: true })
      try {
        signal.throwIfAborted()
        await withDeadline(() => Promise.race([admission, retired]), deadline)
      } finally { signal.removeEventListener("abort", onAbort) }
    } else await withDeadline(() => admission, deadline)
    return await result
  }
}

export async function handleNativeBrowserRequest(controller: BrowserController, method: string, params: unknown, deadline = Number.POSITIVE_INFINITY, checkAdmission?: () => void): Promise<unknown> {
  const input = params as { sessionID?: unknown; command?: unknown; target?: unknown; workspaceIDs?: unknown } | undefined
  if (!input || typeof input.sessionID !== "string") throw new Error("Invalid browser request")
  if (method === "browser.probe") {
    const workspaces = input.workspaceIDs
    if (workspaces !== undefined && (!Array.isArray(workspaces) || workspaces.length > 1024 || !workspaces.every(id => validId(id, 256)))) {
      throw new Error("Invalid browser request")
    }
    return controller.probe(input.sessionID, deadline, checkAdmission, workspaces as string[] | undefined)
  }
  if (["browser.page.begin", "browser.page.send", "browser.page.check", "browser.page.end"].includes(method)) {
    return controller.page(method, input as Record<string, unknown>, deadline, checkAdmission)
  }
  if (method === "browser.execute" && input.command && typeof input.command === "object") {
    const command = input.command as BrowserCommand
    if (command.action === "open") {
      const workspaces = input.workspaceIDs
      if (!Array.isArray(workspaces) || !workspaces.length || workspaces.length > 1024 || !workspaces.every(id => validId(id, 256))) {
        throw new Error("Owning project tabs are unavailable")
      }
      return controller.open(input.sessionID, command.url, deadline, workspaces, checkAdmission)
    }
    return controller.execute(input.sessionID, command, deadline, input.target, checkAdmission)
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

class MainNavigationSuperseded extends Error {
  constructor(readonly successorUrl: string | undefined, cause?: unknown) {
    super("Browser navigation changed", { cause })
  }
}

async function loadNavigation(guest: WebContents, url: string, deadline: number, check: () => void): Promise<{ url: string }> {
  const expected = new URL(url).href
  return loadTriggeredNavigation(guest, expected, deadline, check, () => guest.loadURL(expected))
}

async function loadTriggeredNavigation(
  guest: WebContents,
  url: string,
  deadline: number,
  check: () => void,
  trigger: () => Promise<void>,
): Promise<{ url: string }> {
  const expected = new URL(url).href
  let started = false
  let sameDocument = false
  let committed: string | undefined
  let laterFragment: string | undefined
  let superseded = false
  let rejectLoad!: (error: Error) => void
  const revoked = new Promise<never>((_, reject) => { rejectLoad = reject })
  let complete!: () => void
  const completed = new Promise<void>(resolve => { complete = resolve })
  const startedNavigation = (_event: Electron.Event, destination: string, inPage: boolean, mainFrame: boolean) => {
    if (!mainFrame) return
    if (!started && destination === expected) { started = true; sameDocument = inPage; return }
    if (inPage && committed) return
    superseded = true
    rejectLoad(!inPage && isBrowserUrlAllowed(destination)
      ? new MainNavigationSuperseded(committed === destination || expected === destination ? undefined : destination)
      : new Error("Browser navigation changed"))
  }
  const document = (_event: Electron.Event, destination: string) => {
    if (started && !committed && !superseded) committed = destination
  }
  const inPage = (event: Electron.Event, destination: string, mainFrame: boolean) => {
    if (!mainFrame) return
    if (sameDocument && destination === expected) {
      document(event, destination)
      complete()
    } else if (committed && destination !== committed && isBrowserUrlAllowed(destination)) {
      laterFragment = destination
    }
  }
  const finished = () => { if (!sameDocument && committed) complete() }
  const failed = (_event: Electron.Event, code: number, description: string, failedUrl: string, mainFrame: boolean) => {
    if (mainFrame && started && !superseded && (failedUrl === expected || failedUrl === committed)) {
      rejectLoad(new Error(`Browser navigation failed (${code}): ${description}`))
    }
  }
  const validate = () => {
    ensureDeadline(deadline)
    check()
  }
  const cancel = (error: Error) => {
    rejectLoad(error)
    if (started && !superseded && !laterFragment && !guest.isDestroyed() && guest.isLoading()) guest.stop()
  }
  const timer = setInterval(() => {
    try { validate() } catch (error) { cancel(error as Error) }
  }, 25)
  guest.on("did-start-navigation", startedNavigation)
  guest.on("did-navigate", document)
  guest.on("did-navigate-in-page", inPage)
  guest.on("did-finish-load", finished)
  guest.on("did-fail-load", failed)
  try {
    await Promise.race([Promise.all([trigger(), completed]), revoked])
    validate()
    if (!started || superseded) throw new Error("Browser navigation changed")
    if (!committed || !isBrowserUrlAllowed(committed)) throw new Error("Browser document is unavailable")
    return { url: committed }
  } catch (error) {
    if (laterFragment && !guest.isDestroyed() && guest.getURL() === laterFragment) {
      throw new MainNavigationSuperseded(laterFragment, error)
    }
    throw error
  } finally {
    clearInterval(timer)
    guest.removeListener("did-start-navigation", startedNavigation)
    guest.removeListener("did-navigate", document)
    guest.removeListener("did-navigate-in-page", inPage)
    guest.removeListener("did-finish-load", finished)
    guest.removeListener("did-fail-load", failed)
  }
}
