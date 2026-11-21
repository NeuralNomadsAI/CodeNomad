import { WebSocket } from "undici"
import { randomBytes } from "node:crypto"
import { bindRefs, performAction, snapshotPage, type PageActionResult, type PageSession } from "./automation/page/actions"
import { cdpSession } from "./automation/page/cdp-driver"
import type { RefAction } from "./automation/page/parse"
import { RefTable } from "./automation/page/refs"
import { SnapshotScopeError } from "./automation/page/snapshot"
import { PageTargetChangedError } from "./automation/page/protocol"

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
const DIAGNOSTIC_LIMIT = 1_000
const DIAGNOSTIC_TEXT_LIMIT = 512
const DISCOVERY_TEXT_LIMIT = 256 * 1024
const DISCOVERY_TARGET_LIMIT = 64
const DISCOVERY_PROBE_CONCURRENCY = 4
const INVENTORY_PAGE_MS = 250
const CONTEXT_FUNCTION = `(session) => {
  const root = document.querySelector('[data-tab-visible="true"][data-tab-id]');
  const pane = root?.querySelector('.session-cache-pane[data-session-active="true"][data-session-id]');
  return {
    windowId: window.__CODENOMAD_WINDOW_ID__ ?? null,
    windowInstance: window.__CODENOMAD_WINDOW_INSTANCE__ ?? null,
    instanceId: root?.getAttribute('data-instance-id') ?? null,
    sessionId: pane?.getAttribute('data-session-id') ?? null,
    tabId: root?.getAttribute('data-tab-id') ?? null,
    sessionOpen: session !== null && Array.prototype.some.call(document.querySelectorAll('[data-tab-id][data-instance-id]'),
      tab => tab.getAttribute('data-tab-session-id') === session && !tab.getAttribute('data-instance-id').includes('~')),
  };
}`

export interface DeveloperCdpSelection {
  endpoint: string
  runId: string
  windowId: string
  windowInstance?: string
  sessionId?: string
}

export interface DeveloperCdpIdentity extends DeveloperCdpSelection {
  instanceId?: string
  document?: string
}

function windowKey(identity: DeveloperCdpSelection): string {
  return `${identity.runId}\0${identity.windowId}\0${identity.windowInstance ?? ""}`
}

export interface DeveloperCdpContext {
  windowId: string
  windowInstance?: string
  instanceId: string | null
  sessionId: string | null
  tabId?: string | null
  sessionOpen?: boolean
}

export interface DeveloperCdpDiagnostic {
  level: "log" | "warning" | "error"
  text: string
}

export interface DeveloperCdpInspection {
  target: { id: string; title: string; url: string }
  context: DeveloperCdpContext
  /** Indented accessibility outline with refs (`automation/page/snapshot.ts`). */
  snapshot: string
  document: string
  /** Lines that hide part of the page; inspect their ref to expand them. */
  collapsed: number
  diagnostics: DeveloperCdpDiagnostic[]
}

/** A full inspection, or one limited to a ref's subtree and/or matching text. */
export interface DeveloperCdpInspectOptions {
  ref?: string
  query?: string
}

export interface DeveloperCdpScreenshot {
  mediaType: "image/png"
  data: string
  bytes: number
}

interface CdpSocket {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(): void
}

interface DeveloperCdpDependencies {
  fetch: typeof globalThis.fetch
  connect: (url: string) => CdpSocket
  timeoutMs: number
  maxScreenshotBytes: number
}

interface CdpTarget {
  id: string
  title: string
  type: string
  url: string
  webSocketDebuggerUrl: string
}

interface CdpResponse {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface RunState {
  endpoint: string
  windowId: string
  windowInstance?: string
  sessionId?: string
  instanceId?: string
  context?: DeveloperCdpContext
  target?: CdpTarget
  socket?: CdpSocket
  open?: Promise<void>
  /** Distinguishes this run's refs from an earlier state's on the same target. */
  stamp: number
  refs: RefTable
  nextCommandId: number
  navigationEpoch: number
  pending: Map<number, PendingCommand>
  diagnostics: DeveloperCdpDiagnostic[]
}

export class DeveloperCdp {
  private readonly dependencies: DeveloperCdpDependencies
  private readonly windows = new Map<string, RunState>()
  private readonly operations = new Map<string, Promise<void>>()
  private readonly refNamespace = BigInt(`0x${randomBytes(8).toString("hex")}`).toString().padStart(20, "0")
  private stamps = 0

  constructor(dependencies: Partial<DeveloperCdpDependencies> = {}) {
    this.dependencies = {
      fetch: globalThis.fetch,
      connect: (url) => new WebSocket(url) as unknown as CdpSocket,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxScreenshotBytes: DEFAULT_MAX_SCREENSHOT_BYTES,
      ...dependencies,
    }
  }

  async inspect(identity: DeveloperCdpIdentity, options: DeveloperCdpInspectOptions = {}): Promise<DeveloperCdpInspection> {
    return this.exclusive(windowKey(identity), async () => {
      const state = await this.ensure(identity)
      const generation = this.generation(state)
      const root = options.ref === undefined ? undefined : state.refs.resolve(options.ref, generation)
      let snapshot
      try {
        snapshot = await snapshotPage(this.session(state, state.navigationEpoch, "Page changed during inspection; inspect again"),
          () => state.refs.issuer(generation), { rootBackendNodeId: root, query: options.query, refLength: state.refs.refLength })
      } catch (error) {
        if (error instanceof SnapshotScopeError) throw new Error(`${options.ref} is no longer in the page; inspect again`)
        throw error
      }
      return {
        target: { id: state.target!.id, title: state.target!.title, url: state.target!.url },
        context: this.publicContext(state.context!),
        snapshot: snapshot.text,
        document: generation,
        collapsed: snapshot.collapsed,
        diagnostics: state.diagnostics.splice(0),
      }
    })
  }

  async act(identity: DeveloperCdpIdentity, action: RefAction): Promise<PageActionResult> {
    return this.exclusive(windowKey(identity), async () => {
      const state = await this.ensure(identity)
      const epoch = state.navigationEpoch, generation = this.generation(state)
      const page = bindRefs(action, ref => state.refs.resolve(ref, generation))
      const refFree = (action.action === "press" || action.action === "scroll") && !action.ref || action.action === "wait"
      const foreground = state.context
      const message = "Page changed during action; inspect again"
      const session = this.session(state, epoch, message, refFree ? foreground : undefined)
      if (!refFree) session.beforeInput = () => this.assertContextCurrent(state, epoch, message, foreground)
      return performAction(session, page)
    })
  }

  /** Refs belong to one target and navigation epoch. */
  private generation(state: RunState): string {
    return `${state.stamp}\0${state.target!.id}\0${state.navigationEpoch}`
  }

  private session(state: RunState, epoch: number, message: string, foreground?: DeveloperCdpContext): PageSession {
    return cdpSession({ send: (method, params) => this.command(state, method, params) },
      () => this.assertContextCurrent(state, epoch, message, foreground), true)
  }

  async screenshot(identity: DeveloperCdpIdentity): Promise<DeveloperCdpScreenshot> {
    return this.exclusive(windowKey(identity), async () => {
      const state = await this.ensure(identity)
      const epoch = state.navigationEpoch
      const result = await this.command(state, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      })
      await this.assertContextCurrent(state, epoch, "Page changed during screenshot; capture again")
      if (typeof result.data !== "string") throw new Error("Chrome returned an invalid screenshot")
      const bytes = Buffer.from(result.data, "base64").byteLength
      if (bytes > this.dependencies.maxScreenshotBytes) {
        throw new Error(`Screenshot exceeds ${this.dependencies.maxScreenshotBytes} byte limit`)
      }
      return { mediaType: "image/png", data: result.data, bytes }
    })
  }

  close(runId?: string): void {
    for (const [id, state] of this.windows) {
      if (runId && !id.startsWith(`${runId}\0`)) continue
      this.disconnect(state, new Error("Developer CDP controller closed"))
      this.windows.delete(id)
    }
  }

  async context(selection: DeveloperCdpSelection): Promise<DeveloperCdpContext> {
    return this.exclusive(windowKey(selection), async () => (await this.ensure(selection)).context!)
  }

  async probeContexts(endpoint: string, windowIds: ReadonlyMap<string, string | undefined>,
    sessionID?: string): Promise<Map<string, DeveloperCdpContext>> {
    const source = discoveryUrl(endpoint)
    const pages = await this.listTargets(source)
    const found = new Map<string, DeveloperCdpContext>(), ambiguous = new Set<string>()
    for (let index = 0; index < pages.length; index += DISCOVERY_PROBE_CONCURRENCY) {
      const contexts = await Promise.all(pages.slice(index, index + DISCOVERY_PROBE_CONCURRENCY).map(target =>
        this.probePage(source, target, Math.min(this.dependencies.timeoutMs, INVENTORY_PAGE_MS), sessionID)))
      for (const context of contexts) {
        if (!context || !windowIds.has(context.windowId) || ambiguous.has(context.windowId)) continue
        const expected = windowIds.get(context.windowId)
        if (expected && expected !== context.windowInstance) continue
        if (found.has(context.windowId)) {
          found.delete(context.windowId)
          ambiguous.add(context.windowId)
        } else found.set(context.windowId, context)
      }
    }
    return found
  }

  private publicContext({ sessionOpen: _sessionOpen, ...context }: DeveloperCdpContext): DeveloperCdpContext {
    return context
  }

  private async ensure(identity: DeveloperCdpSelection | DeveloperCdpIdentity): Promise<RunState> {
    if (!identity.runId.trim()) throw new Error("runId is required")
    const endpoint = discoveryUrl(identity.endpoint)
    const key = windowKey(identity)
    let state = this.windows.get(key)
    if (!state || state.endpoint !== endpoint || state.windowId !== identity.windowId || state.sessionId !== identity.sessionId
      || ("instanceId" in identity && state.instanceId !== identity.instanceId)) {
      if (state) this.disconnect(state, new Error("CDP endpoint changed"))
      state = this.newState(endpoint, identity.windowId, identity.sessionId, "instanceId" in identity ? identity.instanceId : undefined)
      state.windowInstance = identity.windowInstance
    }
    this.windows.delete(key)
    this.windows.set(key, state)
    if (this.windows.size > 32) {
      const oldest = this.windows.keys().next().value!
      this.disconnect(this.windows.get(oldest)!, new Error("Developer target retired"))
      this.windows.delete(oldest)
    }
    await this.ensureTarget(state)
    if ("document" in identity && identity.document !== undefined && identity.document !== this.generation(state)) {
      throw new StaleDeveloperDocument()
    }
    return state
  }

  private newState(endpoint: string, windowId: string, sessionId?: string, instanceId?: string): RunState {
    const stamp = ++this.stamps
    return {
      endpoint,
      windowId,
      sessionId,
      instanceId,
      stamp,
      refs: new RefTable("inspect again", `e${this.refNamespace}${String(stamp).padStart(10, "0")}`),
      nextCommandId: 0,
      navigationEpoch: 0,
      pending: new Map(),
      diagnostics: [],
    }
  }

  private async listTargets(endpoint: string): Promise<CdpTarget[]> {
    const response = await this.dependencies.fetch(endpoint, {
      signal: AbortSignal.timeout(this.dependencies.timeoutMs),
    })
    if (!response.ok) throw new Error(`Chrome target discovery failed (HTTP ${response.status})`)
    const contentLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(contentLength) && contentLength > DISCOVERY_TEXT_LIMIT) {
      throw new Error("Chrome target discovery response is too large")
    }
    const text = await response.text()
    if (Buffer.byteLength(text) > DISCOVERY_TEXT_LIMIT) throw new Error("Chrome target discovery response is too large")
    let candidates: unknown
    try { candidates = JSON.parse(text) } catch { throw new Error("Chrome target discovery returned invalid JSON") }
    if (!Array.isArray(candidates)) throw new Error("Chrome target discovery returned invalid JSON")
    return candidates.filter(isTarget).filter((target) => target.type === "page").slice(0, DISCOVERY_TARGET_LIMIT)
  }

  private async ensureTarget(state: RunState): Promise<RunState> {
    const targets = await this.listTargets(state.endpoint)
    let target = state.target && targets.find((candidate) => candidate.id === state.target!.id)
    if (!target) {
      this.disconnect(state, new Error("Chrome target was replaced"))
      target = await this.discoverTarget(state, targets)
    }

    const replaced = state.target?.id !== target.id || state.target.webSocketDebuggerUrl !== target.webSocketDebuggerUrl
    if (replaced) this.disconnect(state, new Error("Chrome target was replaced"))
    state.target = target
    if (!state.socket) await this.connect(state, target)
    else await state.open
    const context = await this.readContext(state)
    if (!this.matchesContext(state, context)) {
      this.invalidateRefs(state)
      state.instanceId = undefined
      this.disconnect(state, new Error("CodeNomad window or active session changed; inspect again"))
      throw new Error("CodeNomad window or active session changed; inspect again")
    }
    state.context = context
    return state
  }

  private async discoverTarget(state: RunState, targets: CdpTarget[], timeoutMs = INVENTORY_PAGE_MS): Promise<CdpTarget> {
    const matches: CdpTarget[] = []
    for (let index = 0; index < targets.length && matches.length < 2; index += DISCOVERY_PROBE_CONCURRENCY) {
      const batch = await Promise.all(targets.slice(index, index + DISCOVERY_PROBE_CONCURRENCY).map(async (target) => {
        const context = await this.probePage(state.endpoint, target, Math.min(this.dependencies.timeoutMs, timeoutMs))
        return context && this.matchesContext(state, context) ? target : undefined
      }))
      matches.push(...batch.filter((target): target is CdpTarget => Boolean(target)))
    }
    if (matches.length === 0) {
      if (state.windowInstance && timeoutMs < this.dependencies.timeoutMs) {
        return this.discoverTarget(state, targets, this.dependencies.timeoutMs)
      }
      throw new Error("No CodeNomad page matches the selected window and OpenCode session")
    }
    if (matches.length > 1) throw new Error("Multiple CodeNomad pages match the selected window and OpenCode session")
    return matches[0]
  }

  private async probePage(endpoint: string, target: CdpTarget, timeoutMs = this.dependencies.timeoutMs,
    sessionID?: string): Promise<DeveloperCdpContext | undefined> {
    const probe = this.newState(endpoint, "")
    const deadline = Date.now() + timeoutMs
    try {
      await this.connect(probe, target, false, timeoutMs)
      return await this.readContext(probe, Math.max(1, deadline - Date.now()), sessionID)
    } catch {
      return undefined
    } finally {
      this.disconnect(probe, new Error("CDP target probe completed"))
    }
  }

  private async readContext(state: RunState, timeoutMs?: number, sessionID?: string): Promise<DeveloperCdpContext> {
    const response = await this.command(state, "Runtime.evaluate", {
      expression: `(${CONTEXT_FUNCTION})(${JSON.stringify(sessionID ?? null)})`,
      returnByValue: true,
    }, timeoutMs)
    const value = (response.result as { value?: unknown } | undefined)?.value as Partial<DeveloperCdpContext> | undefined
    const optionalId = (id: unknown) => id === null || (typeof id === "string" && id.length <= 256)
    if (!value || typeof value.windowId !== "string" || value.windowId.length > 256
      || !optionalId(value.instanceId) || !optionalId(value.sessionId)) {
      throw new Error("CodeNomad page has no valid window context")
    }
    return { windowId: value.windowId, instanceId: value.instanceId!, sessionId: value.sessionId!,
      ...(typeof value.windowInstance === "string" && optionalId(value.windowInstance) ? { windowInstance: value.windowInstance } : {}),
      ...(optionalId(value.tabId) ? { tabId: value.tabId } : {}), ...(value.sessionOpen === true ? { sessionOpen: true } : {}) }
  }

  private matchesContext(state: RunState, context: DeveloperCdpContext): boolean {
    return context.windowId === state.windowId && (state.windowInstance === undefined || state.windowInstance === context.windowInstance)
      && (state.sessionId === undefined || context.sessionId === state.sessionId)
      && (state.instanceId === undefined || context.instanceId === state.instanceId)
  }

  private async connect(state: RunState, target: CdpTarget, enable = true, timeoutMs = this.dependencies.timeoutMs): Promise<void> {
    const socket = this.dependencies.connect(target.webSocketDebuggerUrl)
    state.socket = socket
    state.open = new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timer)
        if (state.socket === socket) {
          this.disconnect(state, error)
        } else socket.close()
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error("CDP WebSocket connection timed out")), timeoutMs)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => fail(new Error("CDP WebSocket connection failed"))
    })
    socket.onmessage = (event) => this.onMessage(state, socket, event.data)
    socket.onclose = () => {
      if (state.socket !== socket) return
      state.socket = undefined
      state.open = undefined
      this.invalidateRefs(state)
      this.rejectPending(state, new Error("CDP WebSocket closed"))
    }
    await state.open
    if (!enable) return
    await this.command(state, "Page.enable")
    await this.command(state, "Runtime.enable")
    await this.command(state, "Accessibility.enable")
  }

  private command(
    state: RunState,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.dependencies.timeoutMs,
  ): Promise<Record<string, unknown>> {
    if (!state.socket) return Promise.reject(new Error("CDP WebSocket is not connected"))
    const id = ++state.nextCommandId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id)
        reject(new Error(`CDP command ${method} timed out`))
      }, timeoutMs)
      state.pending.set(id, { resolve, reject, timer })
      state.socket!.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }))
    })
  }

  private onMessage(state: RunState, socket: CdpSocket, data: unknown): void {
    if (state.socket !== socket) return
    let message: CdpResponse
    try {
      const text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8")
      message = JSON.parse(text) as CdpResponse
    } catch {
      return
    }
    if (typeof message.id === "number") {
      const pending = state.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      state.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? `CDP error ${message.error.code ?? "unknown"}`))
      else pending.resolve(message.result ?? {})
      return
    }
    if ((message.method === "Page.frameNavigated" || message.method === "Page.documentOpened")
      && !(message.params?.frame as { parentId?: string } | undefined)?.parentId) {
      this.invalidateRefs(state)
      return
    }
    const diagnostic = readDiagnostic(message)
    if (diagnostic) {
      state.diagnostics.push(diagnostic)
      if (state.diagnostics.length > DIAGNOSTIC_LIMIT) state.diagnostics.splice(0, state.diagnostics.length - DIAGNOSTIC_LIMIT)
    }
  }

  private async assertContextCurrent(state: RunState, epoch: number, message: string, foreground?: DeveloperCdpContext): Promise<void> {
    if (state.navigationEpoch !== epoch || !state.socket) {
      throw new PageTargetChangedError(message)
    }
    const context = await this.readContext(state)
    if (!this.matchesContext(state, context)) {
      this.invalidateRefs(state)
      state.context = context
      throw new PageTargetChangedError(message)
    }
    if (state.navigationEpoch !== epoch || !state.socket) {
      throw new PageTargetChangedError(message)
    }
    if (foreground && (context.tabId !== foreground.tabId || context.instanceId !== foreground.instanceId
      || context.sessionId !== foreground.sessionId)) throw new PageTargetChangedError("The active tab changed during the action; inspect again", true)
    state.context = context
  }

  private exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(operation)
    const tail = queued.then(() => undefined, () => undefined)
    this.operations.set(key, tail)
    return queued.finally(() => {
      if (this.operations.get(key) === tail) this.operations.delete(key)
    })
  }

  /** A new epoch makes every ref issued before it stale. */
  private invalidateRefs(state: RunState): void {
    state.navigationEpoch++
  }

  private disconnect(state: RunState, error: Error): void {
    const socket = state.socket
    state.socket = undefined
    state.open = undefined
    this.invalidateRefs(state)
    this.rejectPending(state, error)
    socket?.close()
  }

  private rejectPending(state: RunState, error: Error): void {
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    state.pending.clear()
  }
}

export class StaleDeveloperDocument extends Error {
  constructor() { super("Page changed; inspect again") }
}

function discoveryUrl(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error("CDP endpoint must be an HTTP or HTTPS URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CDP endpoint must be an HTTP or HTTPS URL")
  }
  if (url.hostname !== "127.0.0.1") throw new Error("CDP endpoint must use the IPv4 loopback address")
  if (url.username || url.password) throw new Error("CDP endpoint must not contain credentials")
  return new URL("/json/list", url).href
}

function isTarget(value: unknown): value is CdpTarget {
  const target = value as Partial<CdpTarget> | null
  return !!target
    && typeof target.id === "string"
    && typeof target.title === "string"
    && typeof target.type === "string"
    && typeof target.url === "string"
    && typeof target.webSocketDebuggerUrl === "string"
    && isLoopbackWebSocketUrl(target.webSocketDebuggerUrl)
}

function isLoopbackWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "ws:" || url.protocol === "wss:")
      && url.hostname === "127.0.0.1"
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

function readDiagnostic(message: CdpResponse): DeveloperCdpDiagnostic | undefined {
  if (message.method === "Runtime.consoleAPICalled") {
    const params = message.params as { type?: unknown; args?: Array<{ value?: unknown; description?: unknown }> } | undefined
    const text = params?.args?.map((arg) => String(arg.value ?? arg.description ?? "")).join(" ") ?? ""
    const level = params?.type === "error" || params?.type === "assert" ? "error"
      : params?.type === "warning" ? "warning" : "log"
    return { level, text: boundedText(text) }
  }
  if (message.method === "Runtime.exceptionThrown") {
    const params = message.params as { exceptionDetails?: { text?: unknown; exception?: { description?: unknown } } } | undefined
    const detail = params?.exceptionDetails
    return { level: "error", text: boundedText(String(detail?.exception?.description ?? detail?.text ?? "Runtime exception")) }
  }
  return undefined
}

function boundedText(text: string): string {
  return text.length > DIAGNOSTIC_TEXT_LIMIT ? `${text.slice(0, DIAGNOSTIC_TEXT_LIMIT - 3)}...` : text
}
