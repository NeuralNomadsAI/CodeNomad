import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { mkdir, open, opendir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { MissionControlError } from "../missions/control-error"
import { recurrenceSchedulePrincipal, signNativeRecurrenceControl, type RecurrenceControlProofBody } from "../missions/recurrence-control-proof"
import { missionRecoveryControlError, missionRecoveryError } from "../missions/recovery-error"
import { parseMissionCreationDefaultsInput } from "../missions/creation-defaults"
import { MISSION_PREFERENCES_UNAVAILABLE, resolveMissionCreationDefaults } from "../missions/profile-defaults"
import { isConnectionRefused } from "./connection-errors"
import { PAGE_ACTION_PROPERTIES, PAGE_ACTIONS, parsePageAction, type RefAction } from "../automation/page/parse"
import { MemoryError } from "../memory/model"
import type { MemoryErrorCode } from "../memory/model"
import type { MemoryOperation, MemoryResult } from "../memory/api"
import { formatDeveloperTarget, parseDeveloperTarget } from "../automation/developer-target-selector"
import { isRestartSuccessor, readDeveloperTarget,
  type DeveloperRestart } from "../automation/developer-restart"

export const AUTOMATION_BRIDGE_PATH = "/api/opencode-plugin/automation"
const REQUEST_TIMEOUT_MS = 95_000
const PROBE_TIMEOUT_MS = 5_000
// Mission ownership may require a cold, validated linked-worktree inventory.
const MISSION_PROBE_TIMEOUT_MS = 30_000
const INSPECTION_TIMEOUT_MS = 15_000
const RECONNECT_INTERVAL_MS = 250
const MAX_REGISTRATIONS = 64
const MAX_LOCAL_REGISTRY_FILES = 4096
const MAX_REGISTRATION_BYTES = 4 * 1024
const MAX_BRIDGE_RESPONSE_BYTES = 8 * 1024 * 1024
const PROBE_CONCURRENCY = 4
const REGISTRATION_NAME = /^(\d+)-(\d+)-[A-Za-z0-9_-]+\.json$/
const WINDOWS_INTEROP = Symbol("windowsInterop")
type WindowsDiscovery = string | false | null
let cachedWslWindowsLocalAppData: { key: string; value: WindowsDiscovery; expiresAt: number } | undefined
let pendingWslWindowsLocalAppData: { key: string; promise: Promise<WindowsDiscovery> } | undefined

export type DeveloperAction =
  | { action: "inspect"; ref?: string; query?: string }
  | RefAction
  | { action: "restart" }
  | { action: "screenshot" }

const MAX_QUERY_LENGTH = 200

export interface AutomationBridgeRegistration {
  version: 1
  url: string
  token: string
  pid: number
  startedAt: number
}

type ToolDraft = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
interface AutomationPluginContext {
  tool: { transform(callback: (draft: Pick<ToolDraft, "add">) => void): Promise<unknown> }
}

interface BridgeResponse {
  result?: unknown
  error?: string
  code?: unknown
  titles?: string[]
  developerTarget?: unknown
  restartId?: unknown
  windowState?: unknown
}

interface ProbedBridge {
  registration: DiscoveredBridgeRegistration
  nativeIdentity: string
  runId: string
  windows?: DeveloperWindowCandidate[]
  windowId?: string
  windowInstance?: string
  pin?: string
}

interface DeveloperWindowCandidate {
  windowId: string
  windowInstance?: string
  focused: boolean
  session: "visible" | "open" | "elsewhere" | "unknown"
  tabId?: string
}

type DiscoveredBridgeRegistration = AutomationBridgeRegistration & { [WINDOWS_INTEROP]?: true }

type BridgeDirectoryOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  windowsLocalAppData?: WindowsDiscovery
  strict?: boolean
}

export function automationBridgeDirectory(options: BridgeDirectoryOptions = {}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const paths = platform === "win32" ? path.win32 : path.posix
  const home = options.home ?? os.homedir()
  return platform === "win32" && env.LOCALAPPDATA
    ? paths.join(env.LOCALAPPDATA, "CodeNomad", "automation-bridges")
    : env.XDG_RUNTIME_DIR
      ? paths.join(env.XDG_RUNTIME_DIR, "codenomad", "automation-bridges")
      : paths.join(home, ".config", "codenomad", "automation-bridges")
}

export async function automationBridgeDirectories(options: BridgeDirectoryOptions = {}): Promise<string[]> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const primary = automationBridgeDirectory(options)
  if (platform !== "linux" || !env.WSL_DISTRO_NAME) return [primary]
  const windowsLocalAppData = options.windowsLocalAppData !== undefined ? options.windowsLocalAppData : await resolveWslWindowsLocalAppData(env, { strict: options.strict })
  if (options.strict && !windowsLocalAppData && windowsLocalAppData !== false) {
    throw new Error("Windows mission backend discovery is unavailable")
  }
  return windowsLocalAppData
    ? [...new Set([primary, path.posix.join(windowsLocalAppData, "CodeNomad", "automation-bridges")])]
    : [primary]
}

export async function discoverAutomationBridgeDirectories(signal?: AbortSignal, options: BridgeDirectoryOptions = {}): Promise<string[]> {
  signal?.throwIfAborted()
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) !== "linux" || !env.WSL_DISTRO_NAME) return automationBridgeDirectories(options)
  const windowsLocalAppData = options.windowsLocalAppData !== undefined ? options.windowsLocalAppData
    : await resolveWslWindowsLocalAppData(env, { strict: options.strict, signal, cacheFailures: false })
  signal?.throwIfAborted()
  return automationBridgeDirectories({ ...options, windowsLocalAppData })
}

function windowsDiscoveryOutput(file: string, args: string[], encoding: "utf8" | "utf16le",
  env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { env, signal, encoding, timeout: 2_000, maxBuffer: MAX_REGISTRATION_BYTES, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(stdout)))
}

function resolveWslWindowsLocalAppData(env: NodeJS.ProcessEnv, { strict = false, signal, cacheFailures = true }: {
  strict?: BridgeDirectoryOptions["strict"]; signal?: AbortSignal; cacheFailures?: boolean
} = {}): Promise<WindowsDiscovery> {
  const key = `${env.WSL_DISTRO_NAME}\0${env.PATH}`
  const rememberFailures = cacheFailures
  if (cachedWslWindowsLocalAppData?.key === key && (typeof cachedWslWindowsLocalAppData.value === "string"
    || rememberFailures && (!strict || cachedWslWindowsLocalAppData.expiresAt > Date.now()))) return Promise.resolve(cachedWslWindowsLocalAppData.value)
  if (rememberFailures && !signal && pendingWslWindowsLocalAppData?.key === key) return pendingWslWindowsLocalAppData.promise
  const promise = (async (): Promise<WindowsDiscovery> => {
    try {
      const variables = await windowsDiscoveryOutput("cmd.exe", ["/d", "/s", "/u", "/c", "set LOCALAPPDATA"], "utf16le", env, signal)
      signal?.throwIfAborted()
      const windowsPath = /^LOCALAPPDATA=([^\r\n]+)\r?$/im.exec(variables)?.[1]
      if (!windowsPath) return null
      const translated = (await windowsDiscoveryOutput("wslpath", ["-u", windowsPath], "utf8", env, signal)).replace(/\r?\n$/, "")
      signal?.throwIfAborted()
      return path.posix.isAbsolute(translated) ? translated : null
    } catch (error) {
      signal?.throwIfAborted()
      return ["ENOENT", "ENOEXEC"].includes((error as NodeJS.ErrnoException).code ?? "") ? false : null
    }
  })().then(value => {
    if (rememberFailures || typeof value === "string") cachedWslWindowsLocalAppData = { key, value, expiresAt: typeof value === "string" ? Infinity : Date.now() + 2_000 }
    return value
  }).finally(() => { if (pendingWslWindowsLocalAppData?.promise === promise) pendingWslWindowsLocalAppData = undefined })
  if (rememberFailures && !signal) pendingWslWindowsLocalAppData = { key, promise }
  return promise
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
  await mkdir(directory, { recursive: true })
  await pruneDeadLocalRegistrations(directory)
  const published = { ...registration, startedAt: Date.now() }
  const target = path.join(directory, `${published.startedAt}-${published.pid}-${published.token.slice(0, 12)}.json`)
  await writeAtomic(target, `${JSON.stringify(published)}\n`)
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
  if (!isLegacyAutomationPlugin(source)) return false
  await rm(pluginPath, { force: true })
  return true
}

export function isLegacyAutomationPlugin(source: string): boolean {
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
  return true
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, target)
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function registrationFile(name: string, local: boolean) {
  const match = REGISTRATION_NAME.exec(name)
  if (!match) return undefined
  const pid = Number(match[2])
  return { name, startedAt: Number(match[1]), deadPublisher: local && !isProcessAlive(pid) }
}

type RegistrationFile = NonNullable<ReturnType<typeof registrationFile>>

async function readRegistration(target: string, { throwReadErrors = false, checkCurrent }: {
  throwReadErrors?: boolean; checkCurrent?: () => void
} = {}): Promise<AutomationBridgeRegistration | null | undefined> {
  const buffer = Buffer.alloc(MAX_REGISTRATION_BYTES + 1)
  let bytesRead = 0
  try {
    const file = await open(target, "r")
    try {
      checkCurrent?.()
      bytesRead = (await file.read(buffer, 0, buffer.length, 0)).bytesRead
    } finally {
      await file.close()
    }
  } catch (error) {
    checkCurrent?.()
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    if (throwReadErrors) throw error
    return undefined
  }
  try {
    if (bytesRead > MAX_REGISTRATION_BYTES) return undefined
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as Partial<AutomationBridgeRegistration>
    if (value.version !== 1 || typeof value.url !== "string" || typeof value.token !== "string"
      || !Number.isSafeInteger(value.pid) || value.pid! <= 0
      || !Number.isSafeInteger(value.startedAt) || value.startedAt! <= 0) return undefined
    const url = new URL(value.url)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== AUTOMATION_BRIDGE_PATH) return undefined
    return value as AutomationBridgeRegistration
  } catch {
    return undefined
  }
}

async function pruneDeadLocalRegistrations(directory: string): Promise<void> {
  try {
    const stream = await opendir(directory)
    const entries: RegistrationFile[] = []
    for await (const entry of stream) {
      if (!entry.isFile()) continue
      const file = registrationFile(entry.name, true)
      if (!file) continue
      entries.push(file)
      if (entries.length > MAX_LOCAL_REGISTRY_FILES * 2) {
        entries.sort((left, right) => right.startedAt - left.startedAt)
        entries.length = MAX_LOCAL_REGISTRY_FILES
      }
    }
    entries.sort((left, right) => right.startedAt - left.startedAt)
    entries.length = Math.min(entries.length, MAX_LOCAL_REGISTRY_FILES)
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      const registration = await readRegistration(target)
      if (entry.deadPublisher || registration && !isProcessAlive(registration.pid)) await rm(target, { force: true })
    }
  } catch {
    // Registry cleanup is best effort; publication and discovery still proceed.
  }
}

export function parseDeveloperAction(input: unknown): DeveloperAction {
  if (!input || typeof input !== "object") throw new Error("Native automation input must be an object")
  const value = input as Record<string, unknown>
  switch (value.action) {
    case "inspect": {
      return { action: "inspect", ...inspectionScope(value, "inspect") }
    }
    case "restart":
    case "screenshot":
      return { action: value.action }
    default: {
      const page = parsePageAction(value, "inspection")
      if (!page) throw new Error("Unsupported native automation action")
      return page
    }
  }
}

function inspectionScope(value: Record<string, unknown>, action: string): { ref?: string; query?: string } {
  if (value.ref !== undefined && typeof value.ref !== "string") throw new Error(`${action} ref must be a ref from the latest inspection`)
  if (value.query !== undefined && (typeof value.query !== "string" || value.query.length > MAX_QUERY_LENGTH)) {
    throw new Error(`${action} query must be text of at most ${MAX_QUERY_LENGTH} characters`)
  }
  return { ...(value.ref ? { ref: value.ref as string } : {}),
    ...(typeof value.query === "string" && value.query.trim() ? { query: value.query } : {}) }
}

/** Fixed human-answer proof callback. The cookie exists only in this private
 * transport envelope; native storage/model output never receives it. */
export async function verifyHumanAnswerBridge(body: import("../missions/human-answer").HumanAnswerProof, proof: string): Promise<boolean> {
  const { assertHumanAnswerFresh, humanAnswerProof } = await import("../missions/human-answer")
  assertHumanAnswerFresh(body)
  for (const registration of await registrations()) {
    if (humanAnswerProof(body, registration.token) !== proof) continue
    try {
      const result = await callBridge(registration, { mode: "human-answer-verify", sessionID: body.sessionID, command: body })
      assertHumanAnswerFresh(body)
      return result.status === 200 && (result.body.result as { admitted?: unknown } | undefined)?.admitted === true
    } catch { return false }
  }
  return false
}

async function registrations({ pruneStale = true, strict }: { pruneStale?: boolean; strict?: "mission" } = {},
  signal?: AbortSignal, checkCurrent = () => signal?.throwIfAborted()): Promise<DiscoveredBridgeRegistration[]> {
  const found: DiscoveredBridgeRegistration[] = []
  const options: BridgeDirectoryOptions = { strict: Boolean(strict) }
  const directories = signal ? await discoverAutomationBridgeDirectories(signal, options) : await automationBridgeDirectories(options)
  for (const [directoryIndex, directory] of directories.entries()) {
    checkCurrent()
    let entries: RegistrationFile[] = []
    const entryLimit = directoryIndex === 0 ? MAX_LOCAL_REGISTRY_FILES : MAX_REGISTRATIONS
    try {
      const stream = await opendir(directory)
      try { checkCurrent() }
      catch (error) { await stream.close().catch(() => undefined); throw error }
      for await (const entry of stream) {
        checkCurrent()
        if (!entry.isFile()) continue
        const file = registrationFile(entry.name, directoryIndex === 0)
        if (!file) continue
        entries.push(file)
        if (strict && entries.length > entryLimit) throw new Error("Mission backend discovery exceeded its bound")
        if (entries.length > entryLimit * 2) {
          entries.sort((left, right) => right.startedAt - left.startedAt)
          entries.length = entryLimit
        }
      }
    } catch (error) {
      checkCurrent()
      if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      continue
    }
    entries.sort((left, right) => right.startedAt - left.startedAt)
    entries.length = Math.min(entries.length, entryLimit)
    for (const entry of entries) {
      checkCurrent()
      const target = path.join(directory, entry.name)
      if (entry.deadPublisher) {
        if (pruneStale) await rm(target, { force: true }).catch(() => undefined)
        continue
      }
      const registration = await readRegistration(target, { throwReadErrors: Boolean(strict), checkCurrent }) as DiscoveredBridgeRegistration | null | undefined
      checkCurrent()
      if (registration === null) continue
      if (!registration) {
        // Mission discovery treats malformed foreign advertisements as unsupported.
        if (strict === "mission" && directoryIndex === 0) throw new Error("Mission backend registration is unreadable")
        continue
      }
      if (directoryIndex === 0 && !isProcessAlive(registration.pid)) {
        if (pruneStale) await rm(target, { force: true }).catch(() => undefined)
        continue
      }
      if (process.platform === "linux" && process.env.WSL_DISTRO_NAME && directoryIndex > 0) registration[WINDOWS_INTEROP] = true
      found.push(registration)
    }
  }
  checkCurrent()
  if (strict && found.length > MAX_REGISTRATIONS) throw new Error("Mission backend discovery exceeded its bound")
  return found.sort((left, right) => right.startedAt - left.startedAt).slice(0, MAX_REGISTRATIONS)
}

/** An HMAC alone could identify an old registration. Demand a fresh response
 * from the selected live backend's existing authenticated bridge as well. */
export async function verifyRecurrenceBridge(body: RecurrenceControlProofBody, proof: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(proof)) return false
  for (const registration of await registrations({ pruneStale: false })) {
    const digest = Buffer.from(signNativeRecurrenceControl(body, registration.token), "hex")
    if (!timingSafeEqual(digest, Buffer.from(proof, "hex"))) continue
    try {
      const principal = recurrenceSchedulePrincipal(body)
      const reply = await callBridge(registration, { mode: "recurrence-control-verify",
        sessionID: principal.kind === "human" ? principal.sessionID : principal.author.coordinatorSessionID, command: body })
      if (reply.status === 200 && reply.body.result && typeof reply.body.result === "object"
        && "admitted" in reply.body.result && reply.body.result.admitted === true) return true
    } catch { /* Missing backend is not a reusable human grant. */ }
  }
  return false
}

async function callBridge(
  registration: DiscoveredBridgeRegistration,
  body: Record<string, unknown>,
  timeoutMs = PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ status: number; body: BridgeResponse }> {
  signal?.throwIfAborted()
  const rejectRedirects = body.mode === "developer-restart" || body.mode === "developer-reconnect"
  if (registration[WINDOWS_INTEROP]) return callWindowsBridge(registration, body, timeoutMs, signal, rejectRedirects)
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  const response = await fetch(registration.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codenomad-automation-token": registration.token },
    body: JSON.stringify(body),
    signal: requestSignal,
    redirect: rejectRedirects ? "error" : "follow",
  })
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_BRIDGE_RESPONSE_BYTES) {
    throw new Error("Native automation bridge response is too large")
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
        throw new Error("Native automation bridge response is too large")
      }
      chunks.push(Buffer.from(value))
    }
  }
  return {
    status: response.status,
    body: JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as BridgeResponse,
  }
}

function callWindowsBridge(
  registration: AutomationBridgeRegistration,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  rejectRedirects: boolean,
): Promise<{ status: number; body: BridgeResponse }> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", [
      // First argument disables curlrc, which can turn on redirect following.
      ...(rejectRedirects ? ["--disable", "--globoff"] : []),
      "--verbose", "--silent", "--show-error", "--max-time", String(timeoutMs / 1_000),
      "--noproxy", "*",
      "--request", "POST",
      "--header", "content-type: application/json",
      "--header", `x-codenomad-automation-token: ${registration.token}`,
      "--data-binary", "@-",
      "--write-out", "\n%{http_code}",
      registration.url,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      return true
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error("Native automation bridge request timed out"))
    }, timeoutMs)
    const onAbort = () => { child.kill(); finish(signal!.reason) }
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_BRIDGE_RESPONSE_BYTES + 16) {
        child.kill()
        finish(new Error("Native automation bridge response is too large"))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((total, value) => total + value.length, 0) < MAX_REGISTRATION_BYTES) stderr.push(chunk)
    })
    child.on("error", (error) => finish(error))
    child.on("close", (code) => {
      if (!finish()) return
      const output = Buffer.concat(stdout, stdoutBytes).toString("utf8")
      const separator = output.lastIndexOf("\n")
      const status = separator >= 0 ? Number(output.slice(separator + 1)) : NaN
      if (rejectRedirects && status >= 300 && status < 400) {
        reject(new Error("Windows native automation bridge redirected the request"))
        return
      }
      if (code !== 0 || !Number.isInteger(status)) {
        // Curl's exit 7 also covers denied sockets. Its connect diagnostic proves
        // refusal; keep verbose headers/private tokens out of the returned error.
        const refused = code === 7 && /\bfailed: Connection refused\b/i.test(Buffer.concat(stderr).toString("utf8"))
        const error = new Error("Windows native automation bridge request failed")
        reject(refused ? Object.assign(error, { code: "ECONNREFUSED" }) : error)
        return
      }
      try {
        resolve({ status, body: JSON.parse(output.slice(0, separator)) as BridgeResponse })
      } catch {
        reject(new Error("Native automation bridge returned an invalid response"))
      }
    })
    child.stdin.on("error", (error) => finish(error))
    child.stdin.end(JSON.stringify(body))
  })
}

interface InspectionResult {
  target: { title: string; url: string }
  context: { windowId: string; windowInstance?: string; instanceId: string | null; sessionId: string | null; tabId?: string | null }
  snapshot: string
  collapsed: number
  diagnostics: Array<{ level: string; text: string }>
}

/** Plain text: an indented outline reads far cheaper than the same tree as indented JSON. */
export function formatInspection(result: InspectionResult): string {
  const { target, context } = result
  const lines = [
    `CodeNomad window ${context.windowId}${context.tabId ? ` · tab ${context.tabId}` : ""} · workspace ${context.instanceId ?? "none"} · conversation ${context.sessionId ?? "none"}`,
    `${target.title} — ${target.url}`,
    "",
    result.snapshot,
  ]
  if (result.collapsed > 0) {
    lines.push("", "A line ending in (+N hidden) collapses that element: inspect its ref to expand it. (+N more) stands for omitted siblings: inspect their parent's ref, or use query to find them.")
  }
  if (result.diagnostics.length) lines.push("", "Runtime diagnostics:", ...result.diagnostics.map(item => `- ${item.level}: ${item.text}`))
  return lines.join("\n")
}

function formatBridgeResult(resultValue: unknown, screenshot = { text: "Captured the connected CodeNomad build.", name: "codenomad.png" }) {
  const result = resultValue as { image?: { data: string; mime: string }; [key: string]: unknown } | undefined
  if (typeof result?.snapshot === "string" && result.target && result.context && Array.isArray(result.diagnostics)) {
    return { content: formatInspection(result as unknown as InspectionResult) }
  }
  if (result?.image) {
    const content = [
      { type: "text", text: screenshot.text },
      { type: "file", uri: `data:${result.image.mime};base64,${result.image.data}`, mime: result.image.mime, name: screenshot.name },
    ] as const
    return {
      content,
    }
  }
  return { content: JSON.stringify(result ?? null, null, 2) }
}

async function probeBridge(registration: DiscoveredBridgeRegistration, sessionID: string, inventory?: boolean, selector?: string): Promise<ProbedBridge | undefined> {
  try {
    const response = await callBridge(registration, { mode: "developer-probe", sessionID,
      ...(selector ? { purpose: "target", target: selector } : inventory ? { purpose: "targets" } : {}) },
    inventory ? INSPECTION_TIMEOUT_MS : PROBE_TIMEOUT_MS)
    const result = response.body.result as { available?: unknown; nativeIdentity?: unknown; runId?: unknown; windows?: unknown; windowId?: unknown; windowInstance?: unknown } | undefined
    const windows = Array.isArray(result?.windows) ? result.windows.slice(0, 16).filter((item): item is DeveloperWindowCandidate =>
      item && typeof item.windowId === "string" && ["visible", "open", "elsewhere", "unknown"].includes(item.session)) : undefined
    return response.status === 200 && result?.available === true && typeof result.nativeIdentity === "string" && typeof result.runId === "string"
      ? { registration, nativeIdentity: result.nativeIdentity, runId: result.runId, windows,
          windowId: typeof result.windowId === "string" ? result.windowId : undefined,
          windowInstance: typeof result.windowInstance === "string" ? result.windowInstance : undefined }
      : undefined
  } catch {
    return undefined
  }
}

async function probeBridges(
  active: DiscoveredBridgeRegistration[],
  sessionID: string,
  options: { limit?: number; inventory?: boolean; selector?: string; accept?: (bridge: ProbedBridge) => boolean } = {},
): Promise<ProbedBridge[]> {
  const found: ProbedBridge[] = []
  const limit = options.limit ?? 2
  for (let index = 0; index < active.length && found.length < limit; index += PROBE_CONCURRENCY) {
    const batch = await Promise.all(active.slice(index, index + PROBE_CONCURRENCY)
      .map((registration) => probeBridge(registration, sessionID, options.inventory, options.selector)))
    for (const value of batch) {
      if (value && (options.accept?.(value) ?? true)) found.push(value)
    }
  }
  return found
}

async function probeMissionBridges(
  active: DiscoveredBridgeRegistration[],
  sessionID: string,
  purpose: "mission" | "mission-preferences" | "mission-prepare",
  /** Counts backends that neither claimed nor disowned the session (a refused connection is no backend). */
  unknown?: { count: number },
): Promise<DiscoveredBridgeRegistration[]> {
  const strict = purpose === "mission-preferences" || purpose === "mission-prepare"
  const found: DiscoveredBridgeRegistration[] = []
  for (let index = 0; index < active.length && found.length < 2; index += PROBE_CONCURRENCY) {
    const batch = await Promise.all(active.slice(index, index + PROBE_CONCURRENCY).map(async (registration) => {
      try {
        const response = await callBridge(registration, { mode: "browser-claim", sessionID, purpose }, MISSION_PROBE_TIMEOUT_MS)
        const result = response.body.result as { available?: unknown; missionCreationDefaults?: unknown; missionPreparationStart?: unknown } | undefined
        if (response.status === 200 && (!strict || result?.available === true)) {
          if (purpose === "mission-prepare" && (result?.missionCreationDefaults !== true || result.missionPreparationStart !== true))
            throw missionRecoveryControlError("mission-preferences-update-required")
          return registration
        }
        if (strict && response.status === 404 && response.body.code === undefined) throw missionRecoveryControlError("mission-preferences-update-required")
        if (strict && !(response.status === 404 && response.body.code === "mission-not-owner")) throw new Error("Mission backend ownership is unavailable")
        if (unknown && response.status !== 404) unknown.count++
        return undefined
      } catch (error) {
        if (isConnectionRefused(error)) return undefined
        if (strict) throw error
        if (unknown) unknown.count++
        return undefined
      }
    }))
    for (const registration of batch) {
      if (registration) found.push(registration)
    }
  }
  return found.slice(0, 2)
}

async function callMissionInput(target: DiscoveredBridgeRegistration, sessionID: string, kind: string, input: unknown): Promise<unknown> {
  const response = await callBridge(target, { mode: "mission-input", sessionID, command: { kind, input } }, REQUEST_TIMEOUT_MS)
  if (response.status !== 200) {
    const recovery = missionRecoveryError(response.body.code, response.body.error)
    if (recovery && recovery.status === response.status) throw missionRecoveryControlError(recovery.code, response.body.error)
    if (["profile-defaults", "configurations"].includes(kind) && response.body.code === "mission-not-owner") throw missionRecoveryControlError("mission-preferences-unavailable")
    if (["profile-defaults", "configurations"].includes(kind) && [400, 404, 405, 501].includes(response.status)) {
      throw missionRecoveryControlError("mission-preferences-update-required")
    }
    throw new Error("CodeNomad could not admit the mission input; inspect ownership/environment and retry the same task")
  }
  return response.body.result
}

export async function resolveMissionProfileDefaults(sessionID: string, input: unknown): Promise<unknown> {
  try {
    const request = parseMissionCreationDefaultsInput(input)
    const targets = await probeMissionBridges(await registrations({ strict: "mission" }), sessionID, "mission-preferences")
    if (targets.length === 0) return {
      ...resolveMissionCreationDefaults({ ...request, preferences: undefined }), preferences: MISSION_PREFERENCES_UNAVAILABLE,
    }
    if (targets.length !== 1) throw new Error("Mission preferences require exactly one owning CodeNomad backend")
    return await callMissionInput(targets[0], sessionID, "profile-defaults", input)
  } catch (error) {
    if (error instanceof MissionControlError && missionRecoveryError(error.code)) throw error
    throw missionRecoveryControlError("mission-preferences-unavailable")
  }
}

export async function readMissionConfigurations(sessionID: string): Promise<unknown> {
  try {
    const targets = await probeMissionBridges(await registrations({ strict: "mission" }), sessionID, "mission-preferences")
    if (targets.length !== 1) throw new Error("Saved configurations require exactly one owning CodeNomad backend")
    return await callMissionInput(targets[0], sessionID, "configurations", {})
  } catch (error) {
    if (error instanceof MissionControlError && missionRecoveryError(error.code)) throw error
    throw missionRecoveryControlError("mission-preferences-unavailable")
  }
}

export async function sendMissionInput(sessionID: string,
  kind: "prompt" | "synthetic" | "cleanup" | "lifecycle" | "create-root" | "prepare" | "schedule" | "settings" | "project-read" | "project-control" | "project-control-verify" | "project-update" | "task-sessions" | "interrupt", input: unknown,
  /** Runs instead when every CodeNomad backend disowns the session, or none runs: the caller's own native effect. */
  unowned?: () => Promise<unknown>): Promise<unknown> {
  let targets: DiscoveredBridgeRegistration[]
  const requiresDefaults = kind === "prepare" || kind === "schedule" || kind === "settings" || kind === "project-read" || kind.startsWith("project-control") || kind === "project-update"
  try {
    // A backend without native browsers can still claim the session for dispatch.
    const unknown = { count: 0 }
    targets = await probeMissionBridges(await registrations({ strict: requiresDefaults ? "mission" : undefined }), sessionID, requiresDefaults ? "mission-prepare" : "mission", unknown)
    if (unowned && !targets.length && !unknown.count) return unowned()
    if (targets.length !== 1) throw new Error("Mission dispatch requires exactly one owning CodeNomad backend")
  } catch (error) {
    if (error instanceof MissionControlError && error.code === "mission-preferences-update-required") throw error
    if (kind === "prepare") {
      throw missionRecoveryControlError("prepare-refused")
    }
    throw error
  }
  return callMissionInput(targets[0], sessionID, kind, input)
}

/** Discover independently of desktop capabilities; never pick between owning backends. */
export async function sendMemoryInput(sessionID: string, command: MemoryOperation, signal?: AbortSignal): Promise<MemoryResult> {
  return sendMemoryBridge(sessionID, "memory-input", command, signal) as Promise<MemoryResult>
}

export async function requestMemoryContext(sessionID: string, signal?: AbortSignal): Promise<import("../memory/contract").MemoryInstructionContext> {
  return sendMemoryBridge(sessionID, "memory-context", undefined, signal) as Promise<import("../memory/contract").MemoryInstructionContext>
}

async function sendMemoryBridge(sessionID: string, mode: "memory-input" | "memory-context", command?: MemoryOperation, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const active = await registrations({}, signal)
  signal?.throwIfAborted()
  const targets: DiscoveredBridgeRegistration[] = []
  let unowned = 0
  for (let index = 0; index < active.length && targets.length < 2; index += PROBE_CONCURRENCY) {
    signal?.throwIfAborted()
    const batch = await Promise.all(active.slice(index, index + PROBE_CONCURRENCY).map(async registration => {
      try {
        const response = await callBridge(registration, { mode: "memory-probe", sessionID }, MISSION_PROBE_TIMEOUT_MS, signal)
        if (response.status === 400 && response.body.code === "invalid") unowned++
        return response.status === 200 ? registration : undefined
      } catch { return undefined }
    }))
    targets.push(...batch.filter((value): value is DiscoveredBridgeRegistration => Boolean(value)))
  }
  signal?.throwIfAborted()
  // Global plugin activation also covers Locations outside CodeNomad. Only an
  // explicit ownership refusal clears stale context there. Context callers also
  // attempt cleanup on transport failures; memory mutations retain strict ownership.
  if (mode === "memory-context" && active.length > 0 && unowned === active.length) return { supported: true, value: null }
  if (targets.length !== 1) throw new MemoryError(targets.length ? "conflict" : "unreadable", "Memory requires exactly one owning CodeNomad backend")
  const response = await callBridge(targets[0]!, { mode, sessionID, ...(command ? { command } : {}) }, REQUEST_TIMEOUT_MS, signal)
  if (response.status !== 200) {
    const codes: MemoryErrorCode[] = ["disabled", "full", "conflict", "invalid", "unreadable", "git_unavailable", "malformed"]
    const code = codes.find(code => code === response.body.code) ?? "unreadable"
    throw new MemoryError(code, code === "full" ? "Memory is full. Merge or delete entries before retrying." : `Memory operation failed: ${code}`, response.body.titles)
  }
  return response.body.result
}

function targetError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function windowSelector(bridge: ProbedBridge, windowId: string, windowInstance?: string) {
  return formatDeveloperTarget({ nativeIdentity: bridge.nativeIdentity, runId: bridge.runId, windowId, windowInstance })
}

const windowRank = (window: DeveloperWindowCandidate) => ["visible", "open", "elsewhere", "unknown"].indexOf(window.session)

async function executeDeveloperTool(inspectedTargets: Map<string, ProbedBridge>,
  sessionID: string, command: DeveloperAction,
  options: { inventory?: boolean; selector?: string; order?: string; isCurrent?: () => boolean; publish?: (target: ProbedBridge) => boolean } = {}) {
  let target = inspectedTargets.get(sessionID)
  let select = options.selector
  const freshInspection = command.action === "inspect" && !command.ref
  if (command.action === "inspect" && select) {
    const exact = select
    const matches = await probeBridges(await registrations(), sessionID, { selector: exact,
      accept: bridge => !!bridge.windowId && windowSelector(bridge, bridge.windowId, bridge.windowInstance) === exact })
    if (!matches.length) throw targetError("target-gone", "The selected window is unavailable; list the targets again")
    if (matches.length > 1) throw targetError("ambiguous-target", "Several backends returned the selected window")
    target = matches[0]
  } else if (command.action === "inspect" && (options.inventory || !target && !command.ref)) {
    const bridges = await probeBridges(await registrations(), sessionID, { inventory: true, limit: MAX_REGISTRATIONS })
    const windows = bridges.flatMap(bridge => (bridge.windows ?? []).map(window => ({
      bridge, window, target: windowSelector(bridge, window.windowId, window.windowInstance),
    })))
    if (options.inventory) return formatBridgeResult({ targets: windows.map(({ target, window }) => ({ target, ...window })) })
    const candidates = bridges.flatMap<{ bridge: ProbedBridge; rank: number; selector?: string }>(bridge => {
      const best = (bridge.windows ?? []).reduce<DeveloperWindowCandidate | undefined>((chosen, window) =>
        !chosen || windowRank(window) < windowRank(chosen) ? window : chosen, undefined)
      return best ? [{ bridge, rank: windowRank(best), selector: windowSelector(bridge, best.windowId, best.windowInstance) }] : []
    }).sort((left, right) => left.rank - right.rank)
    if (!candidates[0]) {
      if (bridges.some(bridge => bridge.windows === undefined)) {
        throw targetError("unsupported-target", "Update CodeNomad to select a window")
      }
      throw targetError("no-window", "No ready local CodeNomad window for this session")
    }
    if (candidates[1]?.rank === candidates[0].rank) {
      throw targetError("ambiguous-target", "Several CodeNomad profiles match; choose a window in inspect({targets:true})")
    }
    target = candidates[0].bridge
    select = candidates[0].selector
  }
  if (!target || !freshInspection && !target.pin) {
    throw targetError("inspect-required", target
      ? "The backend did not return an inspection receipt; update CodeNomad and inspect again"
      : "Run codenomad.inspect before acting on or restarting CodeNomad")
  }
  if (freshInspection && !select && !target.pin) {
    if (!target.windowId) throw targetError("target-gone", "The selected window is unavailable; list the targets again")
    select = windowSelector(target, target.windowId, target.windowInstance)
  }
  if (command.action === "restart") {
    return restartDesktop(inspectedTargets, sessionID, target, options.order!, options.isCurrent!, options.publish!)
  }
  if (options.isCurrent && !options.isCurrent()) throw targetError("stale-inspection", "A newer inspection selected the window")
  const response = await callBridge(target.registration, { mode: "developer-execute", sessionID, command,
    ...(select ? { target: select } : target.pin ? { pin: target.pin } : {}), ...(options.order ? { order: options.order } : {}) },
    REQUEST_TIMEOUT_MS).catch(error => {
    if (isConnectionRefused(error)) throw targetError("target-gone", "The selected backend has closed; list the targets again")
    if (command.action !== "inspect" && command.action !== "screenshot" && command.action !== "wait") {
      throw new Error("The window action outcome is unknown. Inspect the window before retrying.", { cause: error })
    }
    throw error
  })
  if (response.status !== 200) {
    const message = response.body.error || `Native automation failed (${response.status})`
    throw typeof response.body.code === "string" ? targetError(response.body.code, message) : new Error(message)
  }
  if (options.publish) {
    const inspected = inspectedBridge(select ? { ...target, ...parseDeveloperTarget(select) } : target, response.body.result)
    if (!inspected) throw targetError("target-gone", "The inspection returned a different window; list the targets again")
    if (!options.publish(inspected)) throw targetError("stale-inspection", "A newer inspection selected the window")
  }
  return formatBridgeResult(response.body.result)
}

function inspectedBridge(target: ProbedBridge, result: unknown): ProbedBridge | undefined {
  const pin = (result as { pin?: unknown } | undefined)?.pin
  const context = (result as Partial<InspectionResult> | undefined)?.context
  if (!context || context.windowId !== target.windowId || context.windowInstance !== target.windowInstance) return undefined
  return { ...target, pin: typeof pin === "string" && pin ? pin : undefined }
}

async function restartDesktop(inspectedTargets: Map<string, ProbedBridge>, sessionID: string, pinned: ProbedBridge,
  order: string, isCurrent: () => boolean, publish: (target: ProbedBridge) => boolean) {
  const target = readDeveloperTarget(pinned)
  if (!target || !pinned.pin) throw new Error("Restart requires a fresh inspection and matching desktop automation version")
  const existingTokens = new Set((await registrations()).map(({ token }) => token))
  existingTokens.add(pinned.registration.token)
  if (!isCurrent()) throw targetError("stale-inspection", "A newer inspection selected the window")
  inspectedTargets.delete(sessionID)
  const expected = { ...target, restartId: randomUUID() }
  const reconnect = () => waitForRestart(sessionID, expected, existingTokens, order, isCurrent, publish)
  let response
  try {
    response = await callBridge(pinned.registration, { mode: "developer-restart", sessionID, command: expected, pin: pinned.pin }, REQUEST_TIMEOUT_MS)
  } catch (error) {
    if (isConnectionRefused(error)) throw targetError("target-gone", "The selected backend has closed; list the targets again")
    // Admission can close the reply channel. Read the successor; never send the command again.
    return reconnect()
  }
  // Only the successor can confirm the restart, even if its predecessor acknowledged it.
  if (response.status === 200 || response.status === 502 && response.body?.code === "restart-outcome-unknown") return reconnect()
  const message = response.body?.error || `Native restart failed (${response.status})`
  throw typeof response.body?.code === "string" ? targetError(response.body.code, message) : new Error(message)
}

async function waitForRestart(
  sessionID: string,
  expected: DeveloperRestart,
  existingTokens: ReadonlySet<string>,
  order: string,
  isCurrent: () => boolean,
  publish: (target: ProbedBridge) => boolean,
) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const current = () => !signal.aborted && Date.now() < deadline
  let reconnected = false
  const superseded = { content: "CodeNomad restarted; the original inspection was not restored. Inspect again." }
  while (current()) {
    const active = (await registrations({}, signal).catch(() => [])).filter(({ token }) => !existingTokens.has(token))
    for (let index = 0; index < active.length && current(); index += PROBE_CONCURRENCY) {
      const batch = await Promise.allSettled(active.slice(index, index + PROBE_CONCURRENCY).map(async registration => ({
        registration,
        response: await callBridge(registration, { mode: "developer-reconnect", sessionID, command: expected, order,
          ...(!isCurrent() ? { purpose: "confirm" } : {}) },
          INSPECTION_TIMEOUT_MS, signal),
      })))
      for (const candidate of batch) {
        if (!current()) break
        if (candidate.status !== "fulfilled") continue
        const { registration, response } = candidate.value
        if (response.status !== 200 || !response.body || typeof response.body !== "object") continue
        const target = readDeveloperTarget(response.body.developerTarget)
        if (!target || !isRestartSuccessor(expected, target, response.body.restartId)) continue
        reconnected = true
        if (response.body.windowState === "superseded" || !isCurrent()) return superseded
        if (response.body.windowState === "missing") {
          return { content: "CodeNomad restarted, but the inspected window was not restored." }
        }
        const inspected = inspectedBridge({ registration, ...target }, response.body.result)
        if (response.body.windowState === "inspected" && inspected?.pin && (!expected.windowInstance || target.windowInstance)) {
          let formatted
          try { formatted = formatBridgeResult(response.body.result) } catch { continue }
          if (!current()) break
          if (!publish(inspected)) return superseded
          return formatted
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(RECONNECT_INTERVAL_MS, Math.max(0, deadline - Date.now()))))
  }
  if (reconnected) return { content: "CodeNomad restarted, but the inspected window could not be inspected again." }
  throw new Error("CodeNomad restart could not be confirmed. Inspect again before retrying.")
}

export function createDeveloperToolTransform() {
  const inspectedTargets = new Map<string, ProbedBridge>()
  const selections = new Map<string, symbol>()
  const source = randomUUID()
  let sequence = 0
  const selectWindow = async (session: string, command: DeveloperAction, selector?: string) => {
    if (command.action === "restart" && !inspectedTargets.get(session)?.pin) {
      throw targetError("inspect-required", "Run codenomad.inspect before restarting CodeNomad")
    }
    const issued = Symbol()
    const order = `${source}/${++sequence}`
    selections.set(session, issued)
    try {
      return await executeDeveloperTool(inspectedTargets, session, command, { selector, order, isCurrent: () => selections.get(session) === issued, publish: chosen => {
        if (selections.get(session) !== issued) return false
        inspectedTargets.set(session, chosen)
        return true
      } })
    } finally {
      if (selections.get(session) === issued) selections.delete(session)
    }
  }
  return (draft: Pick<ToolDraft, "add">) => {
    draft.add({
      name: "inspect",
      description: "Inspect the connected CodeNomad desktop build: an indented accessibility outline with element refs, runtime diagnostics and the visible conversation. Large parts are collapsed and say so; pass ref to expand one element's subtree, or query to keep only elements whose text or role matches, with their ancestors.",
      input: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Expand only this element's subtree (a ref from the latest inspection)" },
          query: { type: "string", description: "Keep only elements whose name, value or description contains this text, or whose role is exactly this text" },
          targets: { type: "boolean", description: "List eligible local windows and their target identifiers without switching windows" },
          target: { type: "string", description: "Inspect this exact window identifier from targets:true" },
        },
        additionalProperties: false,
      },
      options: { namespace: "codenomad", codemode: false },
      execute: async (input, tool) => {
        const value = input && typeof input === "object" ? input as Record<string, unknown> : {}
        const selector = value.target === undefined ? undefined : formatDeveloperTarget(parseDeveloperTarget(value.target))
        if (value.targets === true && (selector || value.ref !== undefined || value.query !== undefined) || selector && value.ref !== undefined) {
          throw new Error("List targets or inspect a window; use a ref only in the inspected window")
        }
        const command = parseDeveloperAction({ ...value, action: "inspect" })
        const session = tool.sessionID
        if (value.targets === true) return executeDeveloperTool(inspectedTargets, session, command, { inventory: true })
        if (command.action === "inspect" && command.ref) {
          const before = inspectedTargets.get(session)
          const inspection = await executeDeveloperTool(inspectedTargets, session, command)
          if (inspectedTargets.get(session) !== before) throw targetError("stale-inspection", "A newer inspection selected the window")
          return inspection
        }
        return selectWindow(session, command, selector)
      },
    })
    draft.add({
      name: "act",
      description: "Act on refs from the latest codenomad.inspect like a user: click (real pointer at the element's visible centre, refused when covered), type into a field (replacing its text unless clear is false), select native <select> options by label or value, hover, drag onto another ref, scroll (a ref or the page), press a key or chord (optionally after focusing a ref), or wait for text to appear or disappear. restart relaunches the inspected desktop scope and re-inspects only the original window if restored.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...PAGE_ACTIONS, "restart"] },
          ...PAGE_ACTION_PROPERTIES,
        },
        required: ["action"],
        additionalProperties: false,
      },
      options: { namespace: "codenomad", codemode: false },
      execute: (input, tool) => {
        const command = parseDeveloperAction(input)
        return command.action === "restart" ? selectWindow(tool.sessionID, command)
          : executeDeveloperTool(inspectedTargets, tool.sessionID, command)
      },
    })
    draft.add({
      name: "screenshot",
      description: "Capture the visible page of the connected CodeNomad desktop build.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "codenomad", codemode: false },
      execute: (_input, tool) => executeDeveloperTool(inspectedTargets, tool.sessionID, { action: "screenshot" }),
    })
  }
}

export async function setupAutomationPlugin(context: AutomationPluginContext): Promise<void> {
  await context.tool.transform(createDeveloperToolTransform())
}
