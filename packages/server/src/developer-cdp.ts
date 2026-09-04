import { WebSocket } from "undici"

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
const DIAGNOSTIC_LIMIT = 1_000
const SNAPSHOT_NODE_LIMIT = 750
const SNAPSHOT_TEXT_LIMIT = 64 * 1024
const DIAGNOSTIC_TEXT_LIMIT = 512
const DISCOVERY_TEXT_LIMIT = 256 * 1024
const DISCOVERY_TARGET_LIMIT = 64
const DISCOVERY_PROBE_CONCURRENCY = 4
const CONTEXT_EXPRESSION = `(() => {
  const root = document.querySelector('[data-tab-visible="true"][data-instance-id]');
  const pane = root?.querySelector('.session-cache-pane[data-session-active="true"][data-session-id]');
  return {
    windowId: window.__CODENOMAD_WINDOW_ID__ ?? null,
    instanceId: root?.getAttribute('data-instance-id') ?? null,
    sessionId: pane?.getAttribute('data-session-id') ?? null,
  };
})()`

export interface DeveloperCdpSelection {
  endpoint: string
  runId: string
  windowId: string
  sessionId: string
}

export interface DeveloperCdpIdentity extends DeveloperCdpSelection {
  instanceId: string
}

export interface DeveloperCdpContext {
  windowId: string
  instanceId: string
  sessionId: string
}

export interface DeveloperCdpNode {
  ref?: string
  role: string
  name: string
  description?: string
  value?: string
  states?: string[]
}

export interface DeveloperCdpDiagnostic {
  level: "log" | "warning" | "error"
  text: string
}

export interface DeveloperCdpInspection {
  target: { id: string; title: string; url: string }
  context: DeveloperCdpContext
  nodes: DeveloperCdpNode[]
  diagnostics: DeveloperCdpDiagnostic[]
}

export type DeveloperCdpAction =
  | (DeveloperCdpIdentity & { kind: "click"; ref: string })
  | (DeveloperCdpIdentity & { kind: "type"; ref: string; text: string })

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
  sessionId: string
  instanceId?: string
  context?: DeveloperCdpContext
  target?: CdpTarget
  socket?: CdpSocket
  open?: Promise<void>
  nextCommandId: number
  navigationEpoch: number
  pending: Map<number, PendingCommand>
  refs: Map<string, { backendNodeId: number; targetId: string; epoch: number }>
  diagnostics: DeveloperCdpDiagnostic[]
}

interface AxValue { value?: unknown }
interface AxNode {
  ignored?: boolean
  backendDOMNodeId?: number
  role?: AxValue
  name?: AxValue
  description?: AxValue
  value?: AxValue
  properties?: Array<{ name?: string; value?: AxValue }>
}

export class DeveloperCdp {
  private readonly dependencies: DeveloperCdpDependencies
  private readonly runs = new Map<string, RunState>()
  private readonly operations = new Map<string, Promise<void>>()
  private nextRefId = 0

  constructor(dependencies: Partial<DeveloperCdpDependencies> = {}) {
    this.dependencies = {
      fetch: globalThis.fetch,
      connect: (url) => new WebSocket(url) as unknown as CdpSocket,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxScreenshotBytes: DEFAULT_MAX_SCREENSHOT_BYTES,
      ...dependencies,
    }
  }

  async inspect(identity: DeveloperCdpIdentity): Promise<DeveloperCdpInspection> {
    return this.exclusive(identity.runId, async () => {
      const state = await this.ensure(identity)
      const epoch = state.navigationEpoch
      const result = await this.command(state, "Accessibility.getFullAXTree")
      await this.assertContextCurrent(state, epoch, "Page changed during inspection; inspect again")

      state.refs.clear()
      const nodes = Array.isArray(result.nodes) ? result.nodes as AxNode[] : []
      const snapshot: DeveloperCdpNode[] = []
      let textSize = 0
      for (const node of nodes) {
        if (node.ignored || !Number.isInteger(node.backendDOMNodeId)) continue
        const role = valueOf(node.role)
        const name = valueOf(node.name)
        if (!role || (!name && ["generic", "none", "StaticText", "InlineTextBox"].includes(role))) continue
        const description = valueOf(node.description)
        const value = valueOf(node.value)
        const states = (node.properties ?? [])
          .filter((property) => ["checked", "disabled", "expanded", "focused", "selected"].includes(property.name ?? ""))
          .map((property) => `${property.name}=${String(property.value?.value)}`)
        const size = role.length + name.length + description.length + value.length + states.join(" ").length
        if (snapshot.length >= SNAPSHOT_NODE_LIMIT || textSize + size > SNAPSHOT_TEXT_LIMIT) break
        textSize += size
        const ref = `ax${++this.nextRefId}`
        state.refs.set(ref, {
          backendNodeId: node.backendDOMNodeId!,
          targetId: state.target!.id,
          epoch,
        })
        snapshot.push({
          ref,
          role,
          name,
          ...(description ? { description } : {}),
          ...(value ? { value } : {}),
          ...(states.length ? { states } : {}),
        })
      }
      return {
        target: { id: state.target!.id, title: state.target!.title, url: state.target!.url },
        context: state.context!,
        nodes: snapshot,
        diagnostics: state.diagnostics.splice(0),
      }
    })
  }

  async act(action: DeveloperCdpAction): Promise<void> {
    return this.exclusive(action.runId, async () => {
      const state = await this.ensure(action)
      const node = this.resolveRef(state, action.ref)
      if (action.kind === "click") {
        await this.click(state, node.backendNodeId, node.epoch)
        return
      }
      await this.command(state, "DOM.focus", { backendNodeId: node.backendNodeId })
      await this.assertContextCurrent(state, node.epoch, "Page changed during action; inspect again")
      await this.command(state, "Input.insertText", { text: action.text })
      await this.assertContextCurrent(state, node.epoch, "Page changed during action; inspect again")
    })
  }

  async screenshot(identity: DeveloperCdpIdentity): Promise<DeveloperCdpScreenshot> {
    return this.exclusive(identity.runId, async () => {
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
    for (const [id, state] of this.runs) {
      if (runId && id !== runId) continue
      this.disconnect(state, new Error("Developer CDP controller closed"))
      this.runs.delete(id)
    }
  }

  async context(selection: DeveloperCdpSelection): Promise<DeveloperCdpContext> {
    return this.exclusive(selection.runId, async () => (await this.ensure(selection)).context!)
  }

  private async ensure(identity: DeveloperCdpSelection | DeveloperCdpIdentity): Promise<RunState> {
    if (!identity.runId.trim()) throw new Error("runId is required")
    const endpoint = discoveryUrl(identity.endpoint)
    for (const [runId, previous] of this.runs) {
      if (runId === identity.runId) continue
      this.disconnect(previous, new Error("Developer run was replaced"))
      this.runs.delete(runId)
    }
    let state = this.runs.get(identity.runId)
    if (!state || state.endpoint !== endpoint || state.windowId !== identity.windowId || state.sessionId !== identity.sessionId
      || ("instanceId" in identity && state.instanceId !== identity.instanceId)) {
      if (state) this.disconnect(state, new Error("CDP endpoint changed"))
      state = this.newState(endpoint, identity.windowId, identity.sessionId, "instanceId" in identity ? identity.instanceId : undefined)
      this.runs.set(identity.runId, state)
    }
    return this.ensureTarget(state)
  }

  private newState(endpoint: string, windowId: string, sessionId: string, instanceId?: string): RunState {
    return {
      endpoint,
      windowId,
      sessionId,
      instanceId,
      nextCommandId: 0,
      navigationEpoch: 0,
      pending: new Map(),
      refs: new Map(),
      diagnostics: [],
    }
  }

  private async ensureTarget(state: RunState): Promise<RunState> {
    const response = await this.dependencies.fetch(state.endpoint, {
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
    const targets = candidates.slice(0, DISCOVERY_TARGET_LIMIT).filter(isTarget).filter((target) => target.type === "page")
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

  private async discoverTarget(state: RunState, targets: CdpTarget[]): Promise<CdpTarget> {
    const matches: CdpTarget[] = []
    for (let index = 0; index < targets.length && matches.length < 2; index += DISCOVERY_PROBE_CONCURRENCY) {
      const batch = await Promise.all(targets.slice(index, index + DISCOVERY_PROBE_CONCURRENCY).map(async (target) => {
        const probe = this.newState(state.endpoint, state.windowId, state.sessionId, state.instanceId)
        probe.target = target
        try {
          await this.connect(probe, target)
          return this.matchesContext(state, await this.readContext(probe)) ? target : undefined
        } catch {
          // Targets can disappear while Chromium's target list is being inspected.
          return undefined
        } finally {
          this.disconnect(probe, new Error("CDP target probe completed"))
        }
      }))
      matches.push(...batch.filter((target): target is CdpTarget => Boolean(target)))
    }
    if (matches.length === 0) throw new Error("No CodeNomad page matches the selected window and OpenCode session")
    if (matches.length > 1) throw new Error("Multiple CodeNomad pages match the selected window and OpenCode session")
    return matches[0]
  }

  private async readContext(state: RunState): Promise<DeveloperCdpContext> {
    const response = await this.command(state, "Runtime.evaluate", {
      expression: CONTEXT_EXPRESSION,
      returnByValue: true,
    })
    const value = (response.result as { value?: unknown } | undefined)?.value as Partial<DeveloperCdpContext> | undefined
    if (!value || typeof value.windowId !== "string" || typeof value.instanceId !== "string" || typeof value.sessionId !== "string"
      || value.windowId.length > 256 || value.instanceId.length > 256 || value.sessionId.length > 256) {
      throw new Error("CodeNomad page has no active session context")
    }
    return { windowId: value.windowId, instanceId: value.instanceId, sessionId: value.sessionId }
  }

  private matchesContext(state: RunState, context: DeveloperCdpContext): boolean {
    return context.windowId === state.windowId && context.sessionId === state.sessionId
      && (state.instanceId === undefined || context.instanceId === state.instanceId)
  }

  private async connect(state: RunState, target: CdpTarget): Promise<void> {
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
      const timer = setTimeout(() => fail(new Error("CDP WebSocket connection timed out")), this.dependencies.timeoutMs)
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
    await this.command(state, "Page.enable")
    await this.command(state, "Runtime.enable")
    await this.command(state, "Accessibility.enable")
  }

  private command(
    state: RunState,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!state.socket) return Promise.reject(new Error("CDP WebSocket is not connected"))
    const id = ++state.nextCommandId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id)
        reject(new Error(`CDP command ${method} timed out`))
      }, this.dependencies.timeoutMs)
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
    if (message.method === "Page.frameNavigated") {
      state.navigationEpoch++
      state.refs.clear()
      return
    }
    const diagnostic = readDiagnostic(message)
    if (diagnostic) {
      state.diagnostics.push(diagnostic)
      if (state.diagnostics.length > DIAGNOSTIC_LIMIT) state.diagnostics.splice(0, state.diagnostics.length - DIAGNOSTIC_LIMIT)
    }
  }

  private resolveRef(state: RunState, ref: string): { backendNodeId: number; epoch: number } {
    const node = state.refs.get(ref)
    if (!node || node.targetId !== state.target?.id || node.epoch !== state.navigationEpoch) {
      throw new Error(`Unknown or stale accessibility ref: ${ref}`)
    }
    return node
  }

  private async click(state: RunState, backendNodeId: number, epoch: number): Promise<void> {
    await this.command(state, "DOM.scrollIntoViewIfNeeded", { backendNodeId })
    await this.assertContextCurrent(state, epoch, "Page changed during action; inspect again")
    const result = await this.command(state, "DOM.resolveNode", { backendNodeId })
    await this.assertContextCurrent(state, epoch, "Page changed during action; inspect again")
    const objectId = (result.object as { objectId?: unknown } | undefined)?.objectId
    if (typeof objectId !== "string") throw new Error("Chrome could not resolve the element")
    await this.command(state, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { const element = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement; if (!(element instanceof HTMLElement)) throw new Error('Element is unavailable'); element.click(); }",
    })
    await this.assertContextCurrent(state, epoch, "Page changed during action; inspect again")
  }

  private async assertContextCurrent(state: RunState, epoch: number, message: string): Promise<void> {
    if (state.navigationEpoch !== epoch || !state.socket) {
      throw new Error(message)
    }
    const context = await this.readContext(state)
    if (!this.matchesContext(state, context)) {
      this.invalidateRefs(state)
      state.context = context
      throw new Error(message)
    }
    if (state.navigationEpoch !== epoch || !state.socket) {
      throw new Error(message)
    }
    state.context = context
  }

  private exclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(runId) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(operation)
    const tail = queued.then(() => undefined, () => undefined)
    this.operations.set(runId, tail)
    return queued.finally(() => {
      if (this.operations.get(runId) === tail) this.operations.delete(runId)
    })
  }

  private invalidateRefs(state: RunState): void {
    state.navigationEpoch++
    state.refs.clear()
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

function valueOf(value: AxValue | undefined): string {
  return typeof value?.value === "string" ? value.value : ""
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
