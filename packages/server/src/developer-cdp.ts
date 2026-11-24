import { WebSocket } from "undici"
import { randomBytes } from "node:crypto"
import { bindRefs, performAction, snapshotPage, type PageActionResult, type PageSession } from "./automation/page/actions"
import { cdpSession } from "./automation/page/cdp-driver"
import { declaration, FOCUS_MISMATCH, GLOBAL_FUNCTIONS, INPUT_MARK_LEASE_MS, POINTER_COVER, WHEEL_COVER } from "./automation/page/functions"
import type { RefAction } from "./automation/page/parse"
import { RefTable } from "./automation/page/refs"
import { SnapshotScopeError } from "./automation/page/snapshot"
import { InputCheckTimeout, OBJECT_GROUP, PageDriverUnsupportedError, PageTargetChangedError, type InputTarget } from "./automation/page/protocol"

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
const DIAGNOSTIC_LIMIT = 1_000
const DIAGNOSTIC_TEXT_LIMIT = 512
const DISCOVERY_TEXT_LIMIT = 256 * 1024
const DISCOVERY_TARGET_LIMIT = 64
const DISCOVERY_PROBE_CONCURRENCY = 4
const INVENTORY_PAGE_MS = 250
const FRAME_OWNER = /^(iframe|frame|fencedframe|object|embed|portal|webview)$/
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
const FOREGROUND = `const current = (${CONTEXT_FUNCTION})(null);
  const sameWindow = current.windowId === expected.windowId && current.windowInstance === (expected.windowInstance ?? null);
  const sameTab = current.tabId === (expected.tabId ?? null) && current.instanceId === expected.instanceId && current.sessionId === expected.sessionId;`
const INPUT_STATE = "({ root: document.documentElement })"
const GUARDED_CALLS = new Map((["option-click", "programmatic-click", "select", "set-value", "delete-selection"] as const).map(id => {
  const program = declaration(id, true)
  return [program, `function (handle, expected, ...args) {
    const check = () => {
      ${FOREGROUND}
      if (this.root !== document.documentElement || window !== window.top || handle?.ownerDocument !== document || !sameWindow)
        throw new Error("codenomad:action-root");
      if (!sameTab) throw new Error("codenomad:action-tab");
    };
    check();
    return (${program}).call(handle, ...args, check);
  }`]
}))
const INPUT_DESTINATION = (wheel: boolean) => `function (point, expected, release, handle, insertText, dragSource, track, confirmReceiver, confirmed, observeDrag) {
  if (this.root !== document.documentElement || window !== window.top) return "root";
  let target = point ? document.elementFromPoint(point.x, point.y) : document.activeElement;
  while (target?.shadowRoot) {
    const root = target.shadowRoot;
    const inner = point ? root.elementFromPoint(point.x, point.y) : root.activeElement;
    if (!inner || inner === target || (!root.contains(inner) && !target.contains(inner))) break;
    target = inner;
  }
  ${FOREGROUND}
  if (!sameWindow) return "root";
  if (!release && !sameTab) return "tab";
  if (!target || ${FRAME_OWNER}.test(target.localName)) return "frame";
  let capture;
  if (point && this.dragPress) {
    const { id, path } = this.dragPress;
    const holds = node => node.isConnected && node.ownerDocument === document &&
      Element.prototype.hasPointerCapture.call(node, id);
    capture = this.dragCapture;
    if (capture && !holds(capture)) return "receiver";
    if (!capture) this.dragCapture = capture = path.find(holds);
  }
  if (handle && (point || !release)) {
    const element = handle.nodeType === Node.ELEMENT_NODE ? handle : handle.parentElement;
    if (!element?.isConnected || element.ownerDocument !== document) return "element";
    if (point) {
      const cover = (element, ...args) => { ${wheel ? WHEEL_COVER : POINTER_COVER} };
      const blocked = cover(element, target);
      // The source can follow the pointer without capture. In that case retain the exact hit.
      const moved = capture ?? (this.dragPress && dragSource?.isConnected ? dragSource : null);
      if (blocked !== null && !(moved && cover(moved, target) === null)) return "cover:" + blocked;
    } else {
      const field = element, active = target;
      const editable = insertText && !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement);
      if (${FOCUS_MISMATCH}) return "focus";
    }
  }
  const receiver = capture ?? target;
  if (confirmReceiver && (this.hit?.id !== confirmReceiver || this.hit.receiver !== receiver)) return "receiver";
  // A hit retargeted out of a closed shadow root looks like any other host.
  const canHostShadow = /-|^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/;
  if (!target.shadowRoot && canHostShadow.test(target.localName) && target !== confirmed) return target;
  if (track) this.hit = { id: track, receiver };
  // Only a recipient from this trusted press path can become the drag's capture owner.
  if (observeDrag) window.addEventListener("pointerdown", event => {
    if (event.isTrusted && event.pointerType === "mouse" && event.button === 0 &&
        event.clientX === point.x && event.clientY === point.y && event.composedPath()[0] === target)
      this.dragPress = { id: event.pointerId, path: event.composedPath().filter(node => node instanceof Element) };
  }, { capture: true, once: true, signal: AbortSignal.timeout(${INPUT_MARK_LEASE_MS}) });
  return "ready";
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
  recoverUncertainRun?: boolean
}

interface DeveloperCdpInspectionHooks {
  beforeRead?(): void
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

class CdpCommandTimeout extends Error {}

interface RunState {
  endpoint: string
  windowId: string
  windowInstance?: string
  sessionId?: string
  instanceId?: string
  context?: DeveloperCdpContext
  target?: CdpTarget
  socket?: CdpSocket
  cancelOpen?: (error: Error) => void
  /** Distinguishes this run's refs from an earlier state's on the same target. */
  stamp: number
  refs: RefTable
  nextCommandId: number
  navigationEpoch: number
  mainFrameId?: string
  defaultContexts: Map<string, number>
  pending: Map<number, PendingCommand>
  diagnostics: DeveloperCdpDiagnostic[]
}

export class DeveloperCdp {
  private readonly dependencies: DeveloperCdpDependencies
  private readonly windows = new Map<string, RunState>()
  private readonly probes = new Map<RunState, RunState | string>()
  private readonly operations = new Map<string, Promise<void>>()
  private readonly retiredRuns = new Map<string, { closed: boolean; recoverable: boolean }>()
  private closed = false
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

  async inspect(identity: DeveloperCdpIdentity, options: DeveloperCdpInspectOptions = {}, hooks?: DeveloperCdpInspectionHooks): Promise<DeveloperCdpInspection> {
    return this.exclusive(identity, async () => {
      hooks?.beforeRead?.()
      const retirement = this.retiredRuns.get(identity.runId)
      const recovering = Boolean(options.recoverUncertainRun && !options.ref && !identity.document && retirement?.recoverable)
      const state = await this.ensure(identity, recovering)
      hooks?.beforeRead?.()
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
      if (recovering && retirement === this.retiredRuns.get(identity.runId) && retirement) retirement.closed = false
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

  async act(identity: DeveloperCdpIdentity, action: RefAction, checkAdmission?: () => void): Promise<PageActionResult> {
    return this.exclusive(identity, async () => {
      checkAdmission?.()
      const state = await this.ensure(identity)
      checkAdmission?.()
      const epoch = state.navigationEpoch, generation = this.generation(state)
      const page = bindRefs(action, ref => state.refs.resolve(ref, generation))
      const monitorForeground = action.action === "scroll" && !action.ref || action.action === "wait"
      const foreground = state.context!
      const message = "Page changed during action; inspect again"
      const guard = () => {
        if (state.navigationEpoch !== epoch || !state.socket) {
          throw new PageTargetChangedError(message)
        }
      }
      const check = async (context?: DeveloperCdpContext) => {
        guard()
        await this.assertContextCurrent(state, epoch, message, context)
        guard()
      }
      let inputRoot: string | undefined
      let pointerSequence = 0, pointerReceipt: { id: number; x: number; y: number } | undefined
      const getInputRoot = async () => {
        if (!inputRoot) {
          const result = await this.command(state, "Runtime.evaluate", { expression: INPUT_STATE, objectGroup: OBJECT_GROUP })
          inputRoot = (result.result as { objectId?: string } | undefined)?.objectId
          guard()
          if (!inputRoot) throw new PageTargetChangedError(message)
        }
        return inputRoot
      }
      const session: PageSession = cdpSession({ send: async (method, params) => {
        guard()
        const expression = params?.expression
        if (method === "Runtime.callFunctionOn" && typeof params?.functionDeclaration === "string") {
          const functionDeclaration = GUARDED_CALLS.get(params.functionDeclaration)
          if (functionDeclaration) return this.command(state, method, {
            ...params, functionDeclaration, objectId: inputRoot,
            arguments: [{ objectId: params.objectId }, { value: foreground }, ...(params.arguments as unknown[])],
          })
        }
        if (method === "Runtime.evaluate" && (expression === GLOBAL_FUNCTIONS["mark-input"] || expression === GLOBAL_FUNCTIONS["unmark-input"])) {
          const objectId = await getInputRoot()
          guard()
          try {
            const result = await this.command(state, "Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: `function () { if (this.root !== document.documentElement) return "root"; return ${expression} }`,
              returnByValue: true,
            })
            guard()
            const value = (result.result as { value?: unknown } | undefined)?.value
            if (result.exceptionDetails || (expression === GLOBAL_FUNCTIONS["mark-input"]
              ? typeof value !== "number" || !Number.isFinite(value) || value <= 0 : value !== true)) {
              throw new PageTargetChangedError(message)
            }
            return result
          } catch (error) {
            if (error instanceof CdpCommandTimeout) {
              if (expression === GLOBAL_FUNCTIONS["mark-input"]) throw new InputCheckTimeout("The input provenance check timed out; inspect again", true)
              throw error
            }
            throw new PageTargetChangedError(message)
          }
        }
        if (method === "Input.dispatchKeyEvent" || method === "Input.insertText" || method === "Input.dispatchMouseEvent") {
          if (!inputRoot) throw new PageTargetChangedError(message)
          const mouse = method === "Input.dispatchMouseEvent"
          const point = mouse && typeof params?.x === "number" && typeof params.y === "number"
            ? { x: Math.floor(params.x), y: Math.floor(params.y) } : null
          if (mouse && !point) throw new PageTargetChangedError(message)
          const release = params?.type === "mouseReleased" || params?.type === "keyUp"
          const target = session.inputTarget
          const confirmReceiver = point && release && pointerReceipt?.x === point.x && pointerReceipt.y === point.y
            ? pointerReceipt.id : undefined
          if (point && release && !confirmReceiver)
            throw new PageTargetChangedError("Cannot confirm the original pointer recipient; inspect again", true)
          const dragPress = action.action === "drag" && params?.type === "mousePressed"
          const track = point && target && !release && (params?.type === "mousePressed" || target.dragSource) ? ++pointerSequence : undefined
          let status
          try {
            status = await this.inputDestination(state, inputRoot, point, foreground, release, target,
              method === "Input.insertText", track, confirmReceiver, dragPress, action.action === "scroll", guard)
          } catch (error) {
            guard()
            if (error instanceof CdpCommandTimeout)
              throw new InputCheckTimeout("The input destination check timed out; inspect again", true)
            throw new PageTargetChangedError(message)
          }
          guard()
          if (status === "ready") {
            if (!release && checkAdmission) {
              try { checkAdmission() }
              catch (error) { throw new PageTargetChangedError(error instanceof Error ? error.message : String(error), true) }
            }
            if (point) pointerReceipt = track ? { ...point, id: track } : undefined
            return this.command(state, method, point ? { ...params, ...point } : params)
          }
          if (status === "root") throw new PageTargetChangedError(message)
          if (status === "tab") throw new PageTargetChangedError("The active tab changed during the action; inspect again", true)
          if (status === "element") throw new PageTargetChangedError(`${target?.ref} is no longer in the page; inspect again`, true)
          if (status === "focus") throw new PageTargetChangedError(`Keyboard focus changed before input to ${target?.ref}; inspect again`, true)
          if (status === "receiver") throw new PageTargetChangedError("The original pointer recipient changed; inspect again", true)
          if (typeof status === "string" && status.startsWith("cover:"))
            throw new PageTargetChangedError(`${target?.ref} is covered by ${status.slice(6)}; close or move it first, then inspect again`, true)
          throw new PageTargetChangedError(mouse
            ? "Cannot confirm the pointer is in the main document; inspect again"
            : "Keyboard focus is outside the main document or unavailable; focus the main document and inspect again", true)
        }
        if (method === "DOM.resolveNode" && (action.action === "press" || action.action === "type")) {
          const result = await this.command(state, method, params)
          guard()
          const objectId = (result.object as { objectId?: string } | undefined)?.objectId
          if (objectId) {
            const owner = await this.command(state, "Runtime.callFunctionOn", { objectId, returnByValue: true,
              functionDeclaration: "function () { return this.ownerDocument?.defaultView === window.top }" })
            guard()
            if ((owner.result as { value?: unknown } | undefined)?.value !== true)
              throw new PageDriverUnsupportedError("cdp", "keyboard input into a subframe")
          }
          return result
        }
        return this.command(state, method, params)
      } }, () => check(monitorForeground ? foreground : undefined), true)
      // The input channel checks the destination; this guard also works when the renderer stalls.
      session.guardInput = guard
      if (action.action === "click" || action.action === "type" || action.action === "select") {
        try { await getInputRoot() }
        catch (error) { await session.driver.releaseHandles().catch(() => undefined); throw error }
      }
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

  async screenshot(identity: DeveloperCdpIdentity, checkAdmission?: () => void): Promise<DeveloperCdpScreenshot> {
    return this.exclusive(identity, async () => {
      checkAdmission?.()
      const state = await this.ensure(identity)
      checkAdmission?.()
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

  close(runId?: string, recoverable = false): void {
    const error = new Error("Developer CDP controller closed")
    if (runId) this.retiredRuns.set(runId, { closed: true, recoverable })
    else {
      this.closed = true
      this.retiredRuns.clear()
    }
    for (const [id, state] of this.windows) {
      if (runId && !id.startsWith(`${runId}\0`)) continue
      this.disconnect(state, error)
      this.windows.delete(id)
    }
    for (const [probe, owner] of this.probes) {
      if (!runId || owner === runId) this.disconnect(probe, error)
    }
  }

  async context(selection: DeveloperCdpSelection, beforeRead?: () => void): Promise<DeveloperCdpContext> {
    return this.exclusive(selection, async () => {
      beforeRead?.()
      return (await this.ensure(selection)).context!
    })
  }

  private async inputDestination(state: RunState, objectId: string, point: { x: number; y: number } | null,
    context: DeveloperCdpContext, release: boolean, target: InputTarget | undefined, insertText: boolean,
    track: number | undefined, confirmReceiver: number | undefined, observeDrag: boolean, wheel: boolean, guard: () => void): Promise<unknown> {
    const read = async (confirmed?: string) => {
      guard()
      const result = await this.command(state, "Runtime.callFunctionOn", {
        objectId, functionDeclaration: INPUT_DESTINATION(wheel), objectGroup: OBJECT_GROUP,
        arguments: [{ value: point }, { value: context }, { value: release },
          target ? { objectId: target.handle } : { value: null }, { value: insertText },
          target?.dragSource ? { objectId: target.dragSource } : { value: null },
          { value: track ?? null }, { value: confirmReceiver ?? null },
          confirmed ? { objectId: confirmed } : { value: null }, { value: observeDrag }],
      })
      if (result.exceptionDetails) return undefined
      return result.result as { value?: unknown; objectId?: string } | undefined
    }
    const hit = await read()
    if (!hit?.objectId) return hit?.value ?? "root"
    guard()
    const described = await this.command(state, "DOM.describeNode", { objectId: hit.objectId, depth: 0, pierce: true })
    const node = described.node as { shadowRoots?: unknown[] } | undefined
    if (!node || node.shadowRoots?.length) return "frame"
    // A shadow-host candidate may have moved since the describe; sample the same point again.
    return (await read(hit.objectId))?.value ?? "frame"
  }

  async probeContexts(selection: Pick<DeveloperCdpSelection, "endpoint" | "runId">, windowIds: ReadonlyMap<string, string | undefined>,
    sessionID?: string): Promise<Map<string, DeveloperCdpContext>> {
    const { endpoint, runId } = selection
    const retirement = this.retiredRuns.get(runId)
    const current = () => !this.closed && !retirement?.closed && retirement === this.retiredRuns.get(runId)
    if (!current()) return new Map()
    const source = discoveryUrl(endpoint)
    const pages = await this.listTargets(source)
    const found = new Map<string, DeveloperCdpContext>(), ambiguous = new Set<string>()
    for (let index = 0; current() && index < pages.length; index += DISCOVERY_PROBE_CONCURRENCY) {
      const contexts = await Promise.all(pages.slice(index, index + DISCOVERY_PROBE_CONCURRENCY).map(target =>
        this.probePage(source, target, Math.min(this.dependencies.timeoutMs, INVENTORY_PAGE_MS), runId, sessionID)))
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
    return current() ? found : new Map()
  }

  private publicContext({ sessionOpen: _sessionOpen, ...context }: DeveloperCdpContext): DeveloperCdpContext {
    return context
  }

  private async ensure(identity: DeveloperCdpSelection | DeveloperCdpIdentity, recovering = false): Promise<RunState> {
    if (!identity.runId.trim()) throw new Error("runId is required")
    if (this.closed || !recovering && this.retiredRuns.get(identity.runId)?.closed) {
      throw new Error("Developer CDP run is closed; choose a window in inspect({targets:true})")
    }
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
    const guard = () => {
      if (this.windows.get(key) !== state) throw new Error("Developer window was retired; inspect again")
    }
    await this.ensureTarget(state, guard)
    guard()
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
      defaultContexts: new Map(),
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

  private async ensureTarget(state: RunState, guard: () => void): Promise<void> {
    const targets = await this.listTargets(state.endpoint)
    guard()
    let target = state.target && targets.find((candidate) => candidate.id === state.target!.id)
    if (!target) {
      this.disconnect(state, new Error("Chrome target was replaced"))
      target = await this.discoverTarget(state, targets, guard)
      guard()
    }

    const replaced = state.target?.id !== target.id || state.target.webSocketDebuggerUrl !== target.webSocketDebuggerUrl
    if (replaced) this.disconnect(state, new Error("Chrome target was replaced"))
    state.target = target
    if (!state.socket) await this.connect(state, target)
    guard()
    const context = await this.readContext(state)
    guard()
    if (!this.matchesContext(state, context)) {
      this.invalidateRefs(state)
      state.instanceId = undefined
      this.disconnect(state, new Error("CodeNomad window or active session changed; inspect again"))
      throw new Error("CodeNomad window or active session changed; inspect again")
    }
    state.context = context
  }

  private async discoverTarget(state: RunState, targets: CdpTarget[], guard: () => void, timeoutMs = INVENTORY_PAGE_MS): Promise<CdpTarget> {
    const matches: CdpTarget[] = []
    for (let index = 0; index < targets.length && matches.length < 2; index += DISCOVERY_PROBE_CONCURRENCY) {
      guard()
      const batch = await Promise.all(targets.slice(index, index + DISCOVERY_PROBE_CONCURRENCY).map(async (target) => {
        const context = await this.probePage(state.endpoint, target, Math.min(this.dependencies.timeoutMs, timeoutMs), state)
        return context && this.matchesContext(state, context) ? target : undefined
      }))
      guard()
      matches.push(...batch.filter((target): target is CdpTarget => Boolean(target)))
    }
    if (matches.length === 0) {
      if (state.windowInstance && timeoutMs < this.dependencies.timeoutMs) {
        return this.discoverTarget(state, targets, guard, this.dependencies.timeoutMs)
      }
      throw new Error("No CodeNomad page matches the selected window and OpenCode session")
    }
    if (matches.length > 1) throw new Error("Multiple CodeNomad pages match the selected window and OpenCode session")
    return matches[0]
  }

  private async probePage(endpoint: string, target: CdpTarget, timeoutMs: number,
    owner: RunState | string, sessionID?: string): Promise<DeveloperCdpContext | undefined> {
    const probe = this.newState(endpoint, "")
    this.probes.set(probe, owner)
    const deadline = Date.now() + timeoutMs
    try {
      await this.connect(probe, target, false, timeoutMs)
      return await this.readContext(probe, Math.max(1, deadline - Date.now()), sessionID)
    } catch {
      return undefined
    } finally {
      this.probes.delete(probe)
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
    const open = new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { if (state.socket === socket) this.disconnect(state, error) }
      const timer = setTimeout(() => fail(new Error("CDP WebSocket connection timed out")), timeoutMs)
      state.cancelOpen = error => {
        clearTimeout(timer)
        reject(error)
      }
      socket.onopen = () => {
        if (state.socket !== socket) return
        clearTimeout(timer)
        state.cancelOpen = undefined
        resolve()
      }
      socket.onerror = () => fail(new Error("CDP WebSocket connection failed"))
    })
    socket.onmessage = (event) => this.onMessage(state, socket, event.data)
    socket.onclose = () => {
      if (state.socket !== socket) return
      this.disconnect(state, new Error("CDP WebSocket closed"))
    }
    await open
    if (!enable) return
    try {
      await this.command(state, "Page.enable")
      const result = await this.command(state, "Page.getFrameTree")
      state.mainFrameId ??= (result.frameTree as { frame?: { id?: string } } | undefined)?.frame?.id
      if (!state.mainFrameId) throw new Error("CDP did not report the main frame")
      await this.command(state, "Runtime.enable")
      await this.command(state, "Accessibility.enable")
    } catch (error) {
      if (state.socket === socket) this.disconnect(state, new Error("CDP initialization failed"))
      throw error
    }
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
        reject(new CdpCommandTimeout(`CDP command ${method} timed out`))
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
    if (message.method === "Runtime.executionContextsCleared") {
      state.defaultContexts.clear()
      this.invalidateRefs(state)
      return
    }
    if (message.method === "Runtime.executionContextCreated") {
      const context = message.params?.context as { id?: number; auxData?: { isDefault?: boolean; frameId?: string } } | undefined
      const frameId = context?.auxData?.frameId
      if (typeof context?.id === "number" && context.auxData?.isDefault && typeof frameId === "string") {
        const previous = state.defaultContexts.get(frameId)
        if (frameId === state.mainFrameId && previous !== undefined && previous !== context.id) this.invalidateRefs(state)
        state.defaultContexts.set(frameId, context.id)
      }
      return
    }
    if (message.method === "Runtime.executionContextDestroyed") {
      const id = message.params?.executionContextId
      if (typeof id !== "number") return
      for (const [frameId, contextId] of state.defaultContexts) {
        if (contextId !== id) continue
        state.defaultContexts.delete(frameId)
        if (frameId === state.mainFrameId) this.invalidateRefs(state)
        break
      }
      return
    }
    if (message.method === "Page.frameDetached" || message.method === "Page.frameAttached") {
      const frameId = message.params?.frameId
      if (typeof frameId === "string") {
        if (frameId === state.mainFrameId) this.invalidateRefs(state)
        if (message.method === "Page.frameDetached") state.defaultContexts.delete(frameId)
      }
      return
    }
    if (message.method === "Page.frameNavigated" || message.method === "Page.documentOpened") {
      const frame = message.params?.frame as { id?: string; parentId?: string } | undefined
      if (!frame?.parentId) {
        if (frame?.id) state.mainFrameId = frame.id
        this.invalidateRefs(state)
      }
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

  private exclusive<T>(identity: DeveloperCdpSelection, operation: () => Promise<T>): Promise<T> {
    const key = windowKey(identity)
    const admission = this.retiredRuns.get(identity.runId)
    const previous = this.operations.get(key) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(() => {
      if (admission !== this.retiredRuns.get(identity.runId)) throw new Error("Developer CDP run is closed; inspect again")
      return operation()
    })
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
    state.cancelOpen?.(error)
    state.cancelOpen = undefined
    state.mainFrameId = undefined
    state.defaultContexts.clear()
    this.invalidateRefs(state)
    this.rejectPending(state, error)
    socket?.close()
    for (const [probe, owner] of this.probes) {
      if (owner === state) {
        this.probes.delete(probe)
        this.disconnect(probe, error)
      }
    }
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
