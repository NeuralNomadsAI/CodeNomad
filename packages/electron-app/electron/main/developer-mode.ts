import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface DeveloperTargetStatus {
  state: "stopped" | "starting" | "ready"
  runId?: string
  nativeIdentity?: string
  cdpUrl?: string
  windowId?: string
}

interface DeveloperModeOptions {
  devtoolsDataPath: string
  nativeIdentity: string
  windows(): Array<{ windowId: string; focused: boolean }>
  requestRelaunch(): void
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
    let port: number
    try {
      const value = (await readFile(join(this.options.devtoolsDataPath, "DevToolsActivePort"), "utf8")).split(/\r?\n/, 1)[0]
      port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return { status: base, windows: [] }
    } catch {
      return { status: base, windows: [] }
    }
    const input = params as { windowId?: unknown; runId?: unknown } | undefined
    const windows = this.options.windows()
    const window = input?.runId !== undefined || input?.windowId !== undefined
      ? input.runId === this.runId && windows.find(value => value.windowId === input.windowId)
      : windows[0]
    const cdpUrl = `http://127.0.0.1:${port}`
    const status: DeveloperTargetStatus = window
      ? { ...base, cdpUrl, state: "ready", windowId: window.windowId }
      : { ...base, cdpUrl }
    return { status, windows }
  }

  async handleNativeRequest(method: string, params?: unknown): Promise<unknown> {
    if (method === "developer.status") return { status: await this.status(params), logs: [] }
    if (method === "developer.targets") return { ...await this.inventory(), logs: [] }
    if (method === "developer.restart") {
      const status = await this.status()
      this.schedule(() => this.options.requestRelaunch())
      return { ...status, state: "starting", windowId: undefined }
    }
    throw new Error(`Unsupported native developer request: ${method}`)
  }
}
