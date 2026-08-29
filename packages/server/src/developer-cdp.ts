import { WebSocket } from "undici"

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
const DIAGNOSTIC_LIMIT = 1_000
const SNAPSHOT_NODE_LIMIT = 750
const SNAPSHOT_TEXT_LIMIT = 64 * 1024
const DIAGNOSTIC_TEXT_LIMIT = 512

export interface DeveloperCdpIdentity {
  endpoint: string
  runId: string
  targetId: string
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
  nodes: DeveloperCdpNode[]
  diagnostics: DeveloperCdpDiagnostic[]
}

export type DeveloperCdpAction =
  | { runId: string; kind: "click"; ref: string }
  | { runId: string; kind: "type"; ref: string; text: string }

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
  preferredTargetId: string
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
    const state = await this.ensure(identity)
    const epoch = state.navigationEpoch
    const result = await this.command(state, "Accessibility.getFullAXTree")
    if (epoch !== state.navigationEpoch) throw new Error("Page navigated during inspection; inspect again")

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
      nodes: snapshot,
      diagnostics: state.diagnostics.splice(0),
    }
  }

  async act(action: DeveloperCdpAction): Promise<void> {
    const state = await this.ensureRun(action.runId)
    const node = this.resolveRef(state, action.ref)
    if (action.kind === "click") {
      await this.click(state, node.backendNodeId, node.epoch)
      return
    }
    await this.command(state, "DOM.focus", { backendNodeId: node.backendNodeId })
    this.assertActionCurrent(state, node.epoch)
    await this.command(state, "Input.insertText", { text: action.text })
  }

  async screenshot(runId: string): Promise<DeveloperCdpScreenshot> {
    const state = await this.ensureRun(runId)
    const result = await this.command(state, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    })
    if (typeof result.data !== "string") throw new Error("Chrome returned an invalid screenshot")
    const bytes = Buffer.from(result.data, "base64").byteLength
    if (bytes > this.dependencies.maxScreenshotBytes) {
      throw new Error(`Screenshot exceeds ${this.dependencies.maxScreenshotBytes} byte limit`)
    }
    return { mediaType: "image/png", data: result.data, bytes }
  }

  close(runId?: string): void {
    for (const [id, state] of this.runs) {
      if (runId && id !== runId) continue
      this.disconnect(state, new Error("Developer CDP controller closed"))
      this.runs.delete(id)
    }
  }

  private async ensure(identity: DeveloperCdpIdentity): Promise<RunState> {
    if (!identity.runId.trim()) throw new Error("runId is required")
    const endpoint = discoveryUrl(identity.endpoint)
    for (const [runId, previous] of this.runs) {
      if (runId === identity.runId) continue
      this.disconnect(previous, new Error("Developer run was replaced"))
      this.runs.delete(runId)
    }
    let state = this.runs.get(identity.runId)
    if (!state || state.endpoint !== endpoint || state.preferredTargetId !== identity.targetId) {
      if (state) this.disconnect(state, new Error("CDP endpoint changed"))
      state = this.newState(endpoint, identity.targetId)
      this.runs.set(identity.runId, state)
    }
    return this.ensureTarget(state)
  }

  private async ensureRun(runId: string): Promise<RunState> {
    const state = this.runs.get(runId)
    if (!state) throw new Error(`Run ${runId} has not been inspected`)
    return this.ensureTarget(state)
  }

  private newState(endpoint: string, preferredTargetId: string): RunState {
    return {
      endpoint,
      preferredTargetId,
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
    const candidates = await response.json() as unknown
    if (!Array.isArray(candidates)) throw new Error("Chrome target discovery returned invalid JSON")
    const targets = candidates.filter(isTarget)
    const target = targets.find((item) => item.id === state.preferredTargetId && item.type === "page")
    if (!target) throw new Error(`Chrome target ${state.preferredTargetId} is unavailable`)

    const replaced = state.target?.id !== target.id || state.target.webSocketDebuggerUrl !== target.webSocketDebuggerUrl
    if (replaced) {
      this.disconnect(state, new Error("Chrome target was replaced"))
    }
    state.target = target
    if (replaced) {
      await this.connect(state, target)
    } else if (!state.socket) {
      await this.connect(state, target)
    } else {
      await state.open
    }
    return state
  }

  private async connect(state: RunState, target: CdpTarget): Promise<void> {
    const socket = this.dependencies.connect(target.webSocketDebuggerUrl)
    state.socket = socket
    state.open = new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timer)
        if (state.socket === socket) {
          state.socket = undefined
          state.open = undefined
        }
        socket.close()
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
    this.assertActionCurrent(state, epoch)
    const result = await this.command(state, "DOM.getBoxModel", { backendNodeId })
    this.assertActionCurrent(state, epoch)
    const content = (result.model as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content) || content.length < 8 || content.some((value) => typeof value !== "number")) {
      throw new Error("Chrome could not determine the element bounds")
    }
    const x = (content[0] + content[2] + content[4] + content[6]) / 4
    const y = (content[1] + content[3] + content[5] + content[7]) / 4
    await this.command(state, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
    this.assertActionCurrent(state, epoch)
    await this.command(state, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
    this.assertActionCurrent(state, epoch)
    await this.command(state, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
  }

  private assertActionCurrent(state: RunState, epoch: number): void {
    if (state.navigationEpoch !== epoch || !state.socket) {
      throw new Error("Page changed during action; inspect again")
    }
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
