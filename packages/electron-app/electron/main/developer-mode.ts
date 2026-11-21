import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { readDeveloperRestart, sameDeveloperTarget, type DeveloperRestart } from "../../../server/src/automation/developer-restart"

// The client may wait 95 s for a lost ACK before spending 95 s reconnecting.
const RECONNECT_RECEIPT_SECONDS = 2 * 95

export interface DeveloperTargetStatus {
  state: "missing" | "starting" | "ready"
  runId?: string
  nativeIdentity?: string
  cdpUrl?: string
  windowId?: string
  windowInstance?: string
  restartId?: string
}

interface DeveloperModeOptions {
  devtoolsDataPath: string
  nativeIdentity: string
  windows(): Array<{ windowId: string; windowInstance?: string; focused: boolean }>
  hasWindow(id: string): boolean
  relaunchScopeGeneration(): number | undefined
  verifyRelaunch?(): Promise<void>
  requestRelaunch(restart: DeveloperRestart): void
  previousRestart?: DeveloperRestart
  runId?: string
  schedule?: (callback: () => void) => void
}

export function appendNodeOption(value: string | undefined, option: string): string {
  const options = value?.trim().split(/\s+/).filter(Boolean) ?? []
  if (!options.includes(option)) options.push(option)
  return options.join(" ")
}

export class DeveloperMode {
  private readonly runId: string
  private readonly schedule: (callback: () => void) => void
  private pendingRestart: number | undefined

  constructor(private readonly options: DeveloperModeOptions) {
    this.runId = options.runId ?? randomUUID()
    this.schedule = options.schedule ?? ((callback) => setTimeout(callback, 100))
  }

  async status(params?: unknown): Promise<DeveloperTargetStatus> {
    return (await this.inventory(params)).status
  }

  private async inventory(params?: unknown) {
    const base = {
      state: "starting" as const,
      runId: this.runId,
      nativeIdentity: this.options.nativeIdentity,
    }
    let port: number | undefined
    try {
      const value = (await readFile(join(this.options.devtoolsDataPath, "DevToolsActivePort"), "utf8")).split(/\r?\n/, 1)[0]
      port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return { status: base, windows: [] }
    } catch {
      return { status: base, windows: [] }
    }
    const input = params as { windowId?: unknown; runId?: unknown; windowInstance?: unknown } | undefined
    const windows = this.options.windows()
    const window = input?.runId !== undefined || input?.windowId !== undefined
      ? input.runId === this.runId && windows.find(value => value.windowId === input.windowId && value.windowInstance === input.windowInstance)
      : windows[0]
    const cdpUrl = `http://127.0.0.1:${port}`
    const status: DeveloperTargetStatus = window
      ? { ...base, cdpUrl, state: "ready", windowId: window.windowId,
          ...(window.windowInstance ? { windowInstance: window.windowInstance } : {}) }
      : { ...base, cdpUrl }
    return { status, windows }
  }

  async handleNativeRequest(method: string, params?: unknown, checkAdmission = () => {}): Promise<unknown> {
    if (method === "developer.status") return { status: await this.status(params), logs: [] }
    if (method === "developer.targets") return { ...await this.inventory(), logs: [] }
    if (method === "developer.reconnect") {
      const expected = readDeveloperRestart(params), previous = this.options.previousRestart
      if (!expected || !previous || !sameDeveloperTarget(expected, previous) || expected.restartId !== previous.restartId
        || process.uptime() >= RECONNECT_RECEIPT_SECONDS) {
        throw new Error("No matching CodeNomad relaunch")
      }
      // Restoration creates the records before the backend starts; loading records are pending.
      const window = this.options.windows().find(value => value.windowId === expected.windowId)
      const status = window
        ? await this.status({ ...window, runId: this.runId })
        : { state: this.options.hasWindow(expected.windowId) ? "starting" : "missing",
            runId: this.runId, nativeIdentity: this.options.nativeIdentity }
      if (process.uptime() >= RECONNECT_RECEIPT_SECONDS) throw new Error("No matching CodeNomad relaunch")
      return { status: { ...status, windowId: expected.windowId, restartId: expected.restartId }, logs: [] }
    }
    if (method === "developer.restartScope") {
      const expected = readDeveloperRestart(params)
      const hasExactWindow = (target: DeveloperRestart) => this.options.windows().some(window =>
        window.windowId === target.windowId && window.windowInstance === target.windowInstance)
      if (!expected || expected.runId !== this.runId || expected.nativeIdentity !== this.options.nativeIdentity
        || !hasExactWindow(expected)) {
        throw new Error("The inspected CodeNomad window or run changed")
      }
      checkAdmission()
      const generation = this.options.relaunchScopeGeneration()
      if (generation === undefined) throw new Error("The CodeNomad host is shutting down")
      if (this.pendingRestart === generation) throw new Error("CodeNomad restart is already pending")
      this.pendingRestart = generation
      if (this.options.verifyRelaunch) {
        try {
          await this.options.verifyRelaunch()
          checkAdmission()
          if (this.options.relaunchScopeGeneration() !== generation) throw new Error("The CodeNomad host is shutting down")
          if (!hasExactWindow(expected)) throw new Error("The inspected CodeNomad window or run changed")
        } catch (error) {
          if (this.pendingRestart === generation) this.pendingRestart = undefined
          throw error
        }
      }
      this.schedule(() => {
        if (this.pendingRestart !== generation) return
        this.pendingRestart = undefined
        if (this.options.relaunchScopeGeneration() !== generation) return
        try { checkAdmission() } catch { return }
        if (hasExactWindow(expected)) this.options.requestRelaunch(expected)
      })
      return expected
    }
    throw new Error(`Unsupported native developer request: ${method}`)
  }
}
