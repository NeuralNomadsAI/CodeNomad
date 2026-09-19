import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import type { BrowserWindow, WebContents } from "electron"
import { isBrowserUrlAllowed } from "./browser-webview-security"

const electron = createRequire(import.meta.url)("electron") as typeof import("electron")

interface BrowserControllerElectron {
  fromId(id: number): WebContents | undefined | null
  fromWebContents(contents: WebContents): BrowserWindow | null
}

interface RegistrationInput {
  sessionId: string
  registrationId: string
  guestWebContentsId: number
}

interface Registration extends RegistrationInput {
  owner: WebContents
  guest: WebContents
}

interface OpenClaim {
  sessionID: string
  url: string
  owner?: WebContents
  failedOwners: Set<WebContents>
}

type BrowserCommand =
  | { action: "open"; url: string }
  | { action: "navigate"; url: string }
  | { action: "snapshot" }
  | { action: "click"; ref: string }
  | { action: "type"; ref: string; text: string; clear?: boolean }
  | { action: "screenshot" }

interface AxNode {
  ignored?: boolean
  backendDOMNodeId?: number
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  properties?: Array<{ name?: string; value?: { value?: unknown } }>
}

export class BrowserController {
  private readonly registrations = new Map<string, Registration>()
  private readonly observedGuests = new Map<number, number>()
  private readonly refs = new Map<number, Map<string, number>>()
  private readonly commandQueues = new WeakMap<WebContents, Promise<void>>()
  private readonly navigationVersions = new WeakMap<WebContents, number>()
  private readonly loadResults = new WeakMap<WebContents, { at: number; url: string; startedUrl: string; error?: Error }>()
  private readonly openClaims = new Map<string, OpenClaim>()

  constructor(
    private readonly requestOpen: (sessionID: string, url: string, requestID: string) => void,
    private readonly electronApi: BrowserControllerElectron = {
      fromId: (id) => electron.webContents.fromId(id),
      fromWebContents: (contents) => electron.BrowserWindow.fromWebContents(contents),
    },
  ) {}

  observeGuest(owner: WebContents, guest: WebContents): void {
    this.observedGuests.set(guest.id, owner.id)
    this.navigationVersions.set(guest, 0)
    let startedUrl = guest.getURL()
    const clearRefs = () => {
      this.refs.delete(guest.id)
      this.navigationVersions.set(guest, (this.navigationVersions.get(guest) ?? 0) + 1)
    }
    guest.on("did-navigate", clearRefs)
    guest.on("did-navigate-in-page", clearRefs)
    guest.on("did-frame-navigate", clearRefs)
    guest.on("did-start-navigation", (_event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) startedUrl = url
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
      this.refs.delete(guest.id)
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
    this.registrations.set(input.registrationId, { ...input, owner, guest })
  }

  unregister(owner: WebContents, registrationId: unknown): void {
    if (typeof registrationId !== "string") return
    const registration = this.registrations.get(registrationId)
    if (registration?.owner === owner) this.registrations.delete(registrationId)
  }

  claimOpen(owner: WebContents, requestID: unknown): boolean {
    if (typeof requestID !== "string" || owner.isDestroyed()) return false
    const claim = this.openClaims.get(requestID)
    if (!claim || claim.failedOwners.has(owner) || (claim.owner && claim.owner !== owner)) return false
    claim.owner = owner
    return true
  }

  releaseOpen(owner: WebContents, requestID: unknown): boolean {
    if (typeof requestID !== "string") return false
    const claim = this.openClaims.get(requestID)
    if (!claim || claim.owner !== owner) return false
    claim.owner = undefined
    claim.failedOwners.add(owner)
    this.requestOpen(claim.sessionID, claim.url, requestID)
    return true
  }

  removeOwner(owner: WebContents): void {
    for (const [id, registration] of this.registrations) {
      if (registration.owner === owner) this.registrations.delete(id)
    }
    for (const [requestID, claim] of this.openClaims) {
      if (claim.owner !== owner) continue
      claim.owner = undefined
      claim.failedOwners.add(owner)
      this.requestOpen(claim.sessionID, claim.url, requestID)
    }
  }

  probe(sessionID: string): { available: boolean } {
    this.resolve(sessionID)
    return { available: true }
  }

  async execute(sessionID: string, command: BrowserCommand, deadline = Number.POSITIVE_INFINITY): Promise<unknown> {
    if (command.action === "open") return this.open(sessionID, command.url, deadline)
    const { guest } = this.resolve(sessionID)
    return this.enqueue(guest, () => {
      ensureDeadline(deadline)
      this.assertCurrentTarget(sessionID, guest)
      return this.executeGuest(guest, command, deadline)
    })
  }

  private async executeGuest(guest: WebContents, command: Exclude<BrowserCommand, { action: "open" }>, deadline: number): Promise<unknown> {
    switch (command.action) {
      case "navigate": {
        if (!isBrowserUrlAllowed(command.url)) throw new Error("Browser navigation requires a credential-free HTTP(S) URL")
        this.refs.delete(guest.id)
        await withDeadline(() => guest.loadURL(command.url), deadline, () => guest.stop())
        return { url: guest.getURL() }
      }
      case "snapshot":
        return this.snapshot(guest, deadline)
      case "click":
        await this.click(guest, command.ref, deadline)
        return { clicked: command.ref, url: guest.getURL() }
      case "type":
        await this.click(guest, command.ref, deadline)
        if (command.clear !== false) await clearFocusedField(guest, deadline)
        await withDebugger(guest, deadline, (debuggerSession) => debuggerSession.sendCommand("Input.insertText", { text: command.text }))
        return { typed: command.ref, url: guest.getURL() }
      case "screenshot": {
        const result = await withDebugger(guest, deadline, (debuggerSession) => debuggerSession.sendCommand("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
        })) as { data?: unknown }
        if (typeof result.data !== "string" || result.data.length > 16 * 1024 * 1024) throw new Error("Browser screenshot is unavailable or too large")
        return { image: { mime: "image/png", data: result.data }, url: guest.getURL() }
      }
    }
  }

  private async open(sessionID: string, url: string, deadline: number): Promise<{ url: string }> {
    if (!isBrowserUrlAllowed(url)) throw new Error("Browser navigation requires a credential-free HTTP(S) URL")
    try {
      const { guest } = this.resolve(sessionID)
      return this.enqueue(guest, async () => {
        ensureDeadline(deadline)
        this.assertCurrentTarget(sessionID, guest)
        this.refs.delete(guest.id)
        await withDeadline(() => guest.loadURL(url), deadline, () => guest.stop())
        this.assertCurrentTarget(sessionID, guest)
        return { url: guest.getURL() }
      })
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "No visible local browser target for this session") throw error
    }

    const requestID = randomUUID()
    this.openClaims.set(requestID, { sessionID, url, failedOwners: new Set() })
    return new Promise<{ url: string }>((resolve, reject) => {
      const requestedAt = Date.now()
      const timeout = setTimeout(() => {
        clearInterval(interval)
        reject(new Error("Timed out waiting for CodeNomad to open the browser preview"))
      }, 10_000)
      const interval = setInterval(() => {
        try {
          ensureDeadline(deadline)
          const { guest } = this.resolve(sessionID)
          clearInterval(interval)
          clearTimeout(timeout)
          void this.enqueue(guest, async () => {
            ensureDeadline(deadline)
            this.assertCurrentTarget(sessionID, guest)
            await waitForMainFrameLoad(guest, url, requestedAt, deadline, () => this.loadResults.get(guest))
            this.assertCurrentTarget(sessionID, guest)
            return { url: guest.getURL() }
          }).then(
            resolve,
            reject,
          )
        } catch (error) {
          if (error instanceof Error && error.message === "No visible local browser target for this session") return
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
      const window = this.electronApi.fromWebContents(registration.owner)
      return Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized())
    })
    if (matches.length === 0) throw new Error("No visible local browser target for this session")
    if (matches.length > 1) throw new Error("Multiple visible browser targets exist for this session")
    return matches[0]
  }

  private assertCurrentTarget(sessionID: string, guest: WebContents): void {
    if (this.resolve(sessionID).guest !== guest) throw new Error("Browser target changed before command execution")
  }

  private async snapshot(guest: WebContents, deadline: number): Promise<{ url: string; snapshot: string }> {
    const navigationVersion = this.navigationVersions.get(guest)
    const result = await withDebugger(guest, deadline, async (debuggerSession) => {
      await debuggerSession.sendCommand("Accessibility.enable")
      return debuggerSession.sendCommand("Accessibility.getFullAXTree")
    }) as { nodes?: AxNode[] }
    const refs = new Map<string, number>()
    const lines: string[] = []
    for (const node of result.nodes ?? []) {
      if (node.ignored || !node.backendDOMNodeId) continue
      const role = stringValue(node.role?.value)
      const name = stringValue(node.name?.value)
      if (!role || (!name && ["generic", "none", "StaticText", "InlineTextBox"].includes(role))) continue
      const ref = `e${refs.size + 1}`
      refs.set(ref, node.backendDOMNodeId)
      const value = stringValue(node.value?.value)
      const states = (node.properties ?? [])
        .filter((property) => ["checked", "disabled", "expanded", "focused", "selected"].includes(property.name ?? ""))
        .map((property) => `${property.name}=${String(property.value?.value)}`)
      lines.push(`[${ref}] ${role}${name ? ` ${JSON.stringify(name)}` : ""}${value ? ` value=${JSON.stringify(value)}` : ""}${states.length ? ` ${states.join(" ")}` : ""}`)
      if (lines.length >= 750 || lines.join("\n").length >= 64 * 1024) break
    }
    if (this.navigationVersions.get(guest) === navigationVersion) this.refs.set(guest.id, refs)
    return { url: guest.getURL(), snapshot: lines.join("\n") || "No accessible elements found" }
  }

  private async click(guest: WebContents, ref: string, deadline: number): Promise<void> {
    const backendNodeId = this.refs.get(guest.id)?.get(ref)
    if (!backendNodeId) throw new Error(`Unknown browser ref ${ref}; take a new snapshot`)
    const navigationVersion = this.navigationVersions.get(guest)
    const assertCurrentRef = () => {
      if (this.navigationVersions.get(guest) !== navigationVersion || this.refs.get(guest.id)?.get(ref) !== backendNodeId) {
        throw new Error(`Unknown browser ref ${ref}; take a new snapshot`)
      }
    }
    await withDebugger(guest, deadline, async (debuggerSession) => {
      await debuggerSession.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId })
      assertCurrentRef()
      const result = await debuggerSession.sendCommand("DOM.getBoxModel", { backendNodeId }) as { model?: { content?: number[] } }
      assertCurrentRef()
      const box = result.model?.content
      if (!box || box.length !== 8) throw new Error(`Browser ref ${ref} is not visible`)
      const x = (box[0] + box[2] + box[4] + box[6]) / 4
      const y = (box[1] + box[3] + box[5] + box[7]) / 4
      await debuggerSession.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
      assertCurrentRef()
      await debuggerSession.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
      assertCurrentRef()
      await debuggerSession.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
    })
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
  const input = params as { sessionID?: unknown; command?: unknown } | undefined
  if (!input || typeof input.sessionID !== "string") throw new Error("Invalid browser request")
  if (method === "browser.probe") return controller.probe(input.sessionID)
  if (method === "browser.execute" && input.command && typeof input.command === "object") {
    return controller.execute(input.sessionID, input.command as BrowserCommand, deadline)
  }
  throw new Error(`Unsupported native method: ${method}`)
}

function ensureDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new Error("Native request expired before execution")
}

function validId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 500) : ""
}

async function withDebugger<T>(guest: WebContents, deadline: number, operation: (debuggerSession: WebContents["debugger"]) => Promise<T>): Promise<T> {
  const attached = guest.debugger.isAttached()
  if (!attached) guest.debugger.attach("1.3")
  try {
    return await withDeadline(() => operation(guest.debugger), deadline, () => {
      if (guest.debugger.isAttached()) guest.debugger.detach()
    })
  } finally {
    if (!attached && guest.debugger.isAttached()) guest.debugger.detach()
  }
}

async function clearFocusedField(guest: WebContents, deadline: number): Promise<void> {
  await withDebugger(guest, deadline, async (debuggerSession) => {
    const modifier = process.platform === "darwin"
      ? { key: "Meta", code: "MetaLeft", modifiers: 4, windowsVirtualKeyCode: 91 }
      : { key: "Control", code: "ControlLeft", modifiers: 2, windowsVirtualKeyCode: 17 }
    await debuggerSession.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", ...modifier })
    await debuggerSession.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers: modifier.modifiers,
      windowsVirtualKeyCode: 65,
      commands: ["selectAll"],
    })
    await debuggerSession.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: modifier.modifiers,
      windowsVirtualKeyCode: 65,
    })
    await debuggerSession.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
    })
  })
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
