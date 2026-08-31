import { randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, open, opendir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const AUTOMATION_BRIDGE_PATH = "/api/opencode-plugin/automation"
const REQUEST_TIMEOUT_MS = 95_000
const PROBE_TIMEOUT_MS = 5_000
const INSPECTION_TIMEOUT_MS = 15_000
const RECONNECT_INTERVAL_MS = 250
const MAX_REGISTRATIONS = 64
const MAX_REGISTRATION_BYTES = 4 * 1024
const MAX_BRIDGE_RESPONSE_BYTES = 8 * 1024 * 1024
const PROBE_CONCURRENCY = 4
const REGISTRATION_NAME = /^(\d+)-\d+-[A-Za-z0-9_-]+\.json$/
let cachedWslWindowsLocalAppData: string | null | undefined

export type DeveloperAction =
  | { action: "inspect" }
  | { action: "click"; ref: string }
  | { action: "type"; ref: string; text: string }
  | { action: "restart" }
  | { action: "screenshot" }

export interface AutomationBridgeRegistration {
  version: 1
  url: string
  token: string
  pid: number
  startedAt: number
}

interface ToolContext {
  readonly sessionID: string
}

interface ToolDraft {
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    options: { namespace: string; codemode: false }
    execute(input: unknown, context: ToolContext): Promise<{ content: string | Array<Record<string, string>> }>
  }): void
}

interface AutomationPluginContext {
  tool: {
    transform(callback: (draft: ToolDraft) => void): Promise<unknown>
  }
}

interface BridgeResponse {
  result?: unknown
  error?: string
}

interface ProbedBridge {
  registration: AutomationBridgeRegistration
  nativeIdentity: string
  runId: string
}

export function automationBridgeDirectory(): string {
  return automationBridgeDirectories()[0]
}

export function automationBridgeDirectories(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  windowsLocalAppData?: string
} = {}): string[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const paths = platform === "win32" ? path.win32 : path.posix
  const home = options.home ?? os.homedir()
  const primary = platform === "win32" && env.LOCALAPPDATA
    ? paths.join(env.LOCALAPPDATA, "CodeNomad", "automation-bridges")
    : env.XDG_RUNTIME_DIR
      ? paths.join(env.XDG_RUNTIME_DIR, "codenomad", "automation-bridges")
      : paths.join(home, ".config", "codenomad", "automation-bridges")
  if (platform !== "linux" || !env.WSL_DISTRO_NAME) return [primary]
  const windowsLocalAppData = options.windowsLocalAppData ?? resolveWslWindowsLocalAppData()
  return windowsLocalAppData
    ? [...new Set([primary, path.posix.join(windowsLocalAppData, "CodeNomad", "automation-bridges")])]
    : [primary]
}

function resolveWslWindowsLocalAppData(): string | undefined {
  if (cachedWslWindowsLocalAppData !== undefined) return cachedWslWindowsLocalAppData ?? undefined
  try {
    const windowsPath = execFileSync("cmd.exe", ["/d", "/s", "/c", "echo %LOCALAPPDATA%"], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    }).trim()
    const translated = execFileSync("wslpath", ["-u", windowsPath], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim()
    cachedWslWindowsLocalAppData = path.posix.isAbsolute(translated) ? translated : null
  } catch {
    cachedWslWindowsLocalAppData = null
  }
  return cachedWslWindowsLocalAppData ?? undefined
}

export function createAutomationBridgeRegistration(url: string): AutomationBridgeRegistration {
  return {
    version: 1,
    url: new URL(AUTOMATION_BRIDGE_PATH, url).href,
    token: randomBytes(32).toString("base64url"),
    pid: process.pid,
    startedAt: Date.now(),
  }
}

export async function publishAutomationBridge(registration: AutomationBridgeRegistration): Promise<() => Promise<void>> {
  const directory = automationBridgeDirectory()
  const target = path.join(directory, `${registration.startedAt}-${registration.pid}-${registration.token.slice(0, 12)}.json`)
  await mkdir(directory, { recursive: true })
  await writeAtomic(target, `${JSON.stringify(registration)}\n`)
  return () => rm(target, { force: true })
}

export async function removeLegacyAutomationPlugin(
  configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
): Promise<boolean> {
  const pluginPath = path.join(configRoot, "opencode", "plugins", "codenomad-automation.ts")
  let source: string
  try {
    source = await readFile(pluginPath, "utf8")
  } catch {
    return false
  }
  const match = /^export \{ default \} from ("(?:[^"\\]|\\.)*")\s*$/.exec(source)
  if (!match) return false
  let target: URL
  try {
    target = new URL(JSON.parse(match[1]) as string)
  } catch {
    return false
  }
  if (target.protocol !== "file:" || !/(?:\/server\/dist|\/packages\/server\/src)\/opencode\/automation-plugin\.(?:js|ts)$/.test(target.pathname)) {
    return false
  }
  await rm(pluginPath, { force: true })
  return true
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, target)
}

export function parseDeveloperAction(input: unknown): DeveloperAction {
  if (!input || typeof input !== "object") throw new Error("Developer Mode input must be an object")
  const value = input as Record<string, unknown>
  switch (value.action) {
    case "inspect":
    case "restart":
    case "screenshot":
      return { action: value.action }
    case "click":
      if (typeof value.ref !== "string") throw new Error("click requires ref from the latest inspection")
      return { action: "click", ref: value.ref }
    case "type":
      if (typeof value.ref !== "string" || typeof value.text !== "string") throw new Error("type requires ref and text")
      return { action: "type", ref: value.ref, text: value.text }
    default:
      throw new Error("Unsupported Developer Mode action")
  }
}

async function registrations(): Promise<AutomationBridgeRegistration[]> {
  const found: AutomationBridgeRegistration[] = []
  for (const directory of automationBridgeDirectories()) {
    let entries: Array<{ name: string; startedAt: number }> = []
    try {
      const stream = await opendir(directory)
      for await (const entry of stream) {
        if (!entry.isFile()) continue
        const match = REGISTRATION_NAME.exec(entry.name)
        if (!match) continue
        entries.push({ name: entry.name, startedAt: Number(match[1]) })
        entries.sort((left, right) => right.startedAt - left.startedAt)
        if (entries.length > MAX_REGISTRATIONS) entries.pop()
      }
    } catch {
      continue
    }
    for (const entry of entries) {
      try {
        const file = await open(path.join(directory, entry.name), "r")
        const buffer = Buffer.alloc(MAX_REGISTRATION_BYTES + 1)
        let bytesRead = 0
        try {
          bytesRead = (await file.read(buffer, 0, buffer.length, 0)).bytesRead
        } finally {
          await file.close()
        }
        if (bytesRead > MAX_REGISTRATION_BYTES) continue
        const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as Partial<AutomationBridgeRegistration>
        if (value.version !== 1 || typeof value.url !== "string" || typeof value.token !== "string"
          || typeof value.pid !== "number" || typeof value.startedAt !== "number") continue
        const url = new URL(value.url)
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== AUTOMATION_BRIDGE_PATH) continue
        found.push(value as AutomationBridgeRegistration)
      } catch {
        // Stale or partially-written registrations are ignored.
      }
    }
  }
  return found.sort((left, right) => right.startedAt - left.startedAt).slice(0, MAX_REGISTRATIONS)
}

async function callBridge(
  registration: AutomationBridgeRegistration,
  body: Record<string, unknown>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ status: number; body: BridgeResponse }> {
  const response = await fetch(registration.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codenomad-automation-token": registration.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_BRIDGE_RESPONSE_BYTES) {
    throw new Error("Developer Mode bridge response is too large")
  }
  const reader = response.body?.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BRIDGE_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error("Developer Mode bridge response is too large")
      }
      chunks.push(Buffer.from(value))
    }
  }
  return {
    status: response.status,
    body: JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as BridgeResponse,
  }
}

function formatBridgeResult(resultValue: unknown) {
  const result = resultValue as { image?: { data: string; mime: string }; [key: string]: unknown } | undefined
  if (result?.image) {
    const content: Array<Record<string, string>> = [
      { type: "text", text: "Captured the connected CodeNomad build." },
      { type: "file", uri: `data:${result.image.mime};base64,${result.image.data}`, mime: result.image.mime, name: "codenomad.png" },
    ]
    return {
      content,
    }
  }
  return { content: JSON.stringify(result ?? null, null, 2) }
}

async function probeBridge(registration: AutomationBridgeRegistration, sessionID: string): Promise<ProbedBridge | undefined> {
  try {
    const response = await callBridge(registration, { mode: "developer-probe", sessionID })
    const result = response.body.result as { available?: unknown; nativeIdentity?: unknown; runId?: unknown } | undefined
    return response.status === 200 && result?.available === true && typeof result.nativeIdentity === "string" && typeof result.runId === "string"
      ? { registration, nativeIdentity: result.nativeIdentity, runId: result.runId }
      : undefined
  } catch {
    return undefined
  }
}

async function probeBridges(active: AutomationBridgeRegistration[], sessionID: string): Promise<ProbedBridge[]> {
  const found: ProbedBridge[] = []
  for (let index = 0; index < active.length && found.length < 2; index += PROBE_CONCURRENCY) {
    const batch = await Promise.all(active.slice(index, index + PROBE_CONCURRENCY)
      .map((registration) => probeBridge(registration, sessionID)))
    found.push(...batch.filter((value): value is ProbedBridge => Boolean(value)))
  }
  return found
}

async function executeDeveloperTool(sessionID: string, command: DeveloperAction) {
  const active = await registrations()
  const targets = await probeBridges(active, sessionID)
  if (targets.length === 0) throw new Error("Developer Mode is not active for the visible CodeNomad session")
  if (targets.length > 1) throw new Error("Multiple CodeNomad instances expose Developer Mode for this session")
  const target = targets[0]
  const response = await callBridge(target.registration, { mode: "developer-execute", sessionID, command }, REQUEST_TIMEOUT_MS)
  if (response.status !== 200) throw new Error(response.body.error || `Developer Mode failed (${response.status})`)
  if (command.action === "restart") {
    return waitForRestart(sessionID, target.nativeIdentity, target.runId, target.registration.token)
  }
  return formatBridgeResult(response.body.result)
}

async function waitForRestart(sessionID: string, nativeIdentity: string, previousRunId: string, previousToken: string) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS
  while (Date.now() < deadline) {
    const active = await registrations()
    const candidates = await probeBridges(
      active.filter((registration) => registration.token !== previousToken),
      sessionID,
    )
    for (const candidate of candidates) {
      try {
        if (candidate.nativeIdentity !== nativeIdentity || candidate.runId === previousRunId) continue
        const inspection = await callBridge(candidate.registration, {
          mode: "developer-execute",
          sessionID,
          command: { action: "inspect" },
        }, INSPECTION_TIMEOUT_MS)
        if (inspection.status === 200) return formatBridgeResult(inspection.body.result)
      } catch {
        // The desktop backend and renderer become ready at different points during relaunch.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(RECONNECT_INTERVAL_MS, Math.max(0, deadline - Date.now()))))
  }
  throw new Error("CodeNomad did not reconnect to the persistent OpenCode session after restart")
}

export async function setupAutomationPlugin(context: AutomationPluginContext): Promise<void> {
  await context.tool.transform((draft) => {
    draft.add({
      name: "inspect",
      description: "Inspect the accessibility tree, runtime feedback, and visible session in the CodeNomad build running in Developer Mode.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "codenomad", codemode: false },
      execute: (_input, tool) => executeDeveloperTool(tool.sessionID, { action: "inspect" }),
    })
    draft.add({
      name: "act",
      description: "Click or type using a ref from the latest codenomad.inspect result, or gracefully relaunch CodeNomad and wait for reconnection.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["click", "type", "restart"] },
          ref: { type: "string", description: "Element ref from the latest inspection" },
          text: { type: "string", description: "Text for type" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      options: { namespace: "codenomad", codemode: false },
      execute: (input, tool) => executeDeveloperTool(tool.sessionID, parseDeveloperAction(input)),
    })
    draft.add({
      name: "screenshot",
      description: "Capture the visible page of the CodeNomad build running in Developer Mode.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "codenomad", codemode: false },
      execute: (_input, tool) => executeDeveloperTool(tool.sessionID, { action: "screenshot" }),
    })
  })
}

export default {
  id: "codenomad.automation",
  setup: setupAutomationPlugin,
}
