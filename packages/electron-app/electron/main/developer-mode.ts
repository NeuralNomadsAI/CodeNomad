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
  targetWindowId(): string | undefined
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

  async status(): Promise<DeveloperTargetStatus> {
    const base = {
      state: "starting" as const,
      runId: this.runId,
      nativeIdentity: this.options.nativeIdentity,
    }
    let port: number
    try {
      const value = (await readFile(join(this.options.devtoolsDataPath, "DevToolsActivePort"), "utf8")).split(/\r?\n/, 1)[0]
      port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return base
    } catch {
      return base
    }
    const windowId = this.options.targetWindowId()
    if (!windowId) return { ...base, cdpUrl: `http://127.0.0.1:${port}` }
    return {
      ...base,
      state: "ready",
      cdpUrl: `http://127.0.0.1:${port}`,
      windowId,
    }
  }

  async handleNativeRequest(method: string): Promise<unknown> {
    if (method === "developer.status") return { status: await this.status(), logs: [] }
    if (method === "developer.restart") {
      const status = await this.status()
      this.schedule(() => this.options.requestRelaunch())
      return { ...status, state: "starting", windowId: undefined }
    }
    throw new Error(`Unsupported native developer request: ${method}`)
  }
}
