import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface DeveloperModeState {
  enabled: boolean
  active: boolean
}

export interface DeveloperTargetStatus {
  state: "stopped" | "starting" | "ready"
  runId?: string
  nativeIdentity?: string
  cdpUrl?: string
  windowId?: string
}

interface DeveloperModeOptions {
  active: boolean
  devtoolsDataPath: string
  nativeIdentity: string
  targetWindowId(): string | undefined
  requestRelaunch(): void
  markerPath?: string
  runId?: string
  schedule?: (callback: () => void) => void
}

export function developerModeMarkerPath(home = homedir()): string {
  return join(home, ".config", "codenomad", "developer-mode")
}

export function readDeveloperModeEnabled(markerPath = developerModeMarkerPath()): boolean {
  return existsSync(markerPath)
}

export async function writeDeveloperModeEnabled(enabled: boolean, markerPath = developerModeMarkerPath()): Promise<void> {
  if (!enabled) {
    await rm(markerPath, { force: true })
    return
  }
  await mkdir(dirname(markerPath), { recursive: true })
  await writeFile(markerPath, "enabled\n", { encoding: "utf8", mode: 0o600 })
}

export function appendNodeOption(value: string | undefined, option: string): string {
  const options = value?.trim().split(/\s+/).filter(Boolean) ?? []
  if (!options.includes(option)) options.push(option)
  return options.join(" ")
}

export class DeveloperMode {
  private readonly runId: string
  private readonly markerPath: string
  private readonly schedule: (callback: () => void) => void

  constructor(private readonly options: DeveloperModeOptions) {
    this.runId = options.runId ?? randomUUID()
    this.markerPath = options.markerPath ?? developerModeMarkerPath()
    this.schedule = options.schedule ?? ((callback) => setTimeout(callback, 100))
  }

  state(): DeveloperModeState {
    return { enabled: readDeveloperModeEnabled(this.markerPath), active: this.options.active }
  }

  async setEnabled(enabled: boolean): Promise<DeveloperModeState> {
    await writeDeveloperModeEnabled(enabled, this.markerPath)
    return this.state()
  }

  async status(): Promise<DeveloperTargetStatus> {
    if (!this.options.active) return { state: "stopped" }
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
      if (!this.options.active) throw new Error("Developer Mode is not active")
      const status = await this.status()
      this.schedule(() => this.options.requestRelaunch())
      return { ...status, state: "starting", windowId: undefined }
    }
    throw new Error(`Unsupported native developer request: ${method}`)
  }
}
