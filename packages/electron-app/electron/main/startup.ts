import { createHash, randomUUID } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { isAbsolute, join, normalize, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { resolveCrossHostStatePath, resolveLegacyCrossHostStatePath, resolveLegacyTauriDataDirectory } from "./client-state-cross-host"
import { profileDisplayName, profileScope, resolveExplicitProfile, type ExplicitProfile } from "./data-profile"
import { resolveTransitionProfile, type TransitionContext, type TransitionResult } from "./profile-transition"

export interface LaunchIntent {
  newWindow: boolean
  folders: string[]
  /** `--connect-server` value: a saved server name or id, or an http(s) URL; empty when the value is missing. */
  connectServer?: string
}

/** A launch that only asks for a remote window: it opens no local window of its own when the connection succeeds. */
export const isConnectOnlyLaunch = (intent: LaunchIntent): boolean =>
  intent.connectServer !== undefined && !intent.newWindow && intent.folders.length === 0

export interface StorageScope {
  /** Profile storage key; `stable` is the default profile (see data-profile.ts). */
  profile: string
  configIdentity: string
  scoped: boolean
  userDataPath: string
  sessionDataPath: string
  clientStateElectionDirectory?: string
}

export interface LocalWindowIdentity {
  id: string
  persisted: boolean
}

export class BackendBootstrapCoordinator {
  private generation = 0
  private ready: { generation: number; url: string } | undefined
  private token: { generation: number; value: string } | undefined
  private inFlight: Promise<void> | undefined

  constructor(
    private readonly exchange: (url: string, token: string) => Promise<boolean>,
    private readonly navigate: (url: string) => void | Promise<void>,
    private readonly reportError: (error: unknown) => void = () => {},
  ) {}

  reset(): void {
    this.generation++
    this.ready = undefined
    this.token = undefined
    this.inFlight = undefined
  }

  setReady(url: string): void {
    this.ready = { generation: this.generation, url }
    this.start()
  }

  setToken(token: string): void {
    this.token = { generation: this.generation, value: token }
    this.start()
  }

  idle(): Promise<void> {
    return this.inFlight ?? Promise.resolve()
  }

  private start(): void {
    if (this.inFlight || !this.ready || !this.token || this.ready.generation !== this.token.generation) return
    const generation = this.generation
    const url = this.ready.url
    const token = this.token.value
    this.inFlight = this.exchange(url, token).then(
      (accepted) => this.generation === generation ? this.navigate(accepted ? url : `${url}/login`) : undefined,
      (error) => {
        this.reportError(error)
        return this.generation === generation ? this.navigate(`${url}/login`) : undefined
      },
    ).then(() => undefined).finally(() => {
      if (this.generation === generation) {
        this.ready = undefined
        this.token = undefined
        this.inFlight = undefined
      }
    })
  }
}

export function startPrimaryInstance(requestLock: () => boolean, losingLaunch: () => void, primaryLaunch: () => void): boolean {
  if (!requestLock()) {
    losingLaunch()
    return false
  }
  primaryLaunch()
  return true
}

export function resolveSelectedConfig(raw: string | undefined, cwd: string): string | undefined {
  let target = raw?.trim()
  if (!target) return undefined
  if (target === "~" || target.startsWith("~/") || target.startsWith("~\\")) {
    target = join(homedir(), target.slice(2))
  } else if (!isAbsolute(target)) {
    target = resolve(cwd, target)
  }
  return normalize(target)
}

export function normalizeConfigIdentity(raw: string | undefined, cwd: string): string {
  let target = resolveSelectedConfig(raw?.trim() || "~/.config/codenomad/config.json", cwd)!
  if (/\.json$/i.test(target)) target = join(resolve(target, ".."), "config.yaml")
  if (!/\.ya?ml$/i.test(target)) target = join(target, "config.yaml")
  return process.platform === "win32" ? target.toLowerCase() : target
}

export interface LaunchProfile {
  key: string
  /** `transition`: a remembered choice, detection or the default profile. */
  source: ExplicitProfile["source"] | "transition"
}

/** `CODENOMAD_PROFILE`, its alias or an unpackaged run decide every launch, so a remembered choice never applies. */
export const isPinnedLaunch = (profile: LaunchProfile) => profile.source !== "transition"

/** Resolves the data profile before any profile path, singleton or Chromium storage is fixed. */
export function resolveLaunchProfile(options: {
  environment: Record<string, string | undefined>
  packaged: boolean
  cliConfig?: string
  cwd: string
  baseUserDataPath: string
  transition?: (context: TransitionContext) => TransitionResult
}): LaunchProfile {
  const explicit = resolveExplicitProfile(options.environment, options.packaged)
  if (explicit) return explicit
  const context: TransitionContext = {
    configIdentity: normalizeConfigIdentity(options.cliConfig, options.cwd),
    defaultIdentity: normalizeConfigIdentity(undefined, options.cwd),
    userDataBase: options.baseUserDataPath,
    defaultStateFiles: [
      resolveCrossHostStatePath(options.environment),
      resolveLegacyCrossHostStatePath(options.environment),
      join(options.baseUserDataPath, "client-state.json"),
      join(resolveLegacyTauriDataDirectory(options.environment), "client-state.json"),
    ],
  }
  const result = (options.transition ?? resolveTransitionProfile)(context)
  console.info(`[electron-startup] data profile ${profileDisplayName(result.key)} (${result.reason})`)
  return { key: result.key, source: "transition" }
}

export function resolveStorageScope(options: {
  profileKey: string
  cliConfig?: string
  cwd: string
  baseUserDataPath: string
  packaged: boolean
}): StorageScope {
  const profile = options.profileKey
  const configIdentity = normalizeConfigIdentity(options.cliConfig, options.cwd)
  const defaultIdentity = normalizeConfigIdentity(undefined, options.cwd)
  const { scoped, scopeName } = profileScope(profile, configIdentity, defaultIdentity)
  const userDataPath = scoped ? join(options.baseUserDataPath, "scopes", scopeName) : options.baseUserDataPath
  return {
    profile,
    configIdentity,
    scoped,
    userDataPath,
    sessionDataPath: join(userDataPath, options.packaged ? "session-data-v2" : "session-data"),
    ...(scoped ? { clientStateElectionDirectory: join(userDataPath, "client-state", "election") } : {}),
  }
}

export function resolveRemoteSessionPartition(profileId: string, proxySessionId?: string): string {
  const identity = proxySessionId ? `${profileId}\0${proxySessionId}` : profileId
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 24)
  return `${proxySessionId ? "" : "persist:"}codenomad-remote-${suffix}`
}

export function isRemoteCertificateAllowed(
  webContentsId: number,
  url: string,
  insecureOrigins: ReadonlyMap<number, ReadonlySet<string>>,
): boolean {
  try { return insecureOrigins.get(webContentsId)?.has(new URL(url).origin) ?? false } catch { return false }
}

export async function allocateLocalWindowIdentity(
  persistedIds: readonly string[],
  isRegistered: (id: string) => boolean,
  addWindow: () => Promise<string | null>,
  reportError: (error: unknown) => void = () => {},
  createId: () => string = randomUUID,
): Promise<LocalWindowIdentity> {
  const retained = persistedIds.find((id) => !isRegistered(id))
  if (retained) return { id: retained, persisted: true }
  try {
    const id = await addWindow()
    if (id) return { id, persisted: true }
  } catch (error) {
    reportError(error)
  }
  return { id: createId(), persisted: false }
}

export function createLaunchIntentQueue(
  handle: (intent: LaunchIntent) => void | Promise<void>,
  reportError: (error: unknown) => void,
) {
  let start!: () => void
  const ready = new Promise<void>((resolve) => { start = resolve })
  let tail = Promise.resolve()
  return {
    enqueue(intent: LaunchIntent): Promise<void> {
      const operation = tail.then(() => ready).then(() => handle(intent))
      tail = operation.catch(reportError)
      return operation
    },
    start,
    idle: () => tail,
  }
}

interface PhysicalFsPromises {
  stat: typeof fsPromises.stat
  readFile: typeof fsPromises.readFile
}

const nodeRequire = createRequire(import.meta.url)

/** Loads Electron's ASAR-free filesystem promises API, falling back to `node:fs/promises` outside Electron. */
function resolvePhysicalFsPromises(): PhysicalFsPromises {
  try {
    const originalFs = nodeRequire("original-fs") as { promises?: Partial<PhysicalFsPromises> } | undefined
    if (typeof originalFs?.promises?.stat === "function" && typeof originalFs?.promises?.readFile === "function") {
      return originalFs.promises as PhysicalFsPromises
    }
  } catch {}
  return fsPromises
}

function isExistingDirectorySync(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

async function isExistingDirectoryAsync(
  candidate: string,
  physicalFs: PhysicalFsPromises = resolvePhysicalFsPromises(),
): Promise<boolean> {
  try {
    return (await physicalFs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

function parseRawLaunchArguments(argv: readonly string[], cwd: string): {
  newWindow: boolean
  folderCandidates: string[]
  connectServer?: string
} {
  const folderCandidates: string[] = []
  let newWindow = false
  let connectServer: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (value === "--new-window") {
      newWindow = true
      continue
    }
    if (value === "--connect-server") {
      const target = argv[index + 1]
      if (target !== undefined && !target.startsWith("-")) {
        index++
        connectServer = target.trim()
      } else {
        connectServer = ""
      }
      continue
    }
    if (value.startsWith("--connect-server=")) {
      connectServer = value.slice("--connect-server=".length).trim()
      continue
    }
    if (value === "--folder") {
      const folder = argv[index + 1]
      if (folder && !folder.startsWith("-")) {
        index++
        folderCandidates.push(resolve(cwd, folder))
      }
      continue
    }
    if (value.startsWith("--folder=")) {
      folderCandidates.push(resolve(cwd, value.slice("--folder=".length)))
      continue
    }
    if (value.startsWith("-")) continue
    folderCandidates.push(resolve(cwd, value))
  }
  return { newWindow, folderCandidates: [...new Set(folderCandidates)], ...(connectServer !== undefined ? { connectServer } : {}) }
}

export function parseLaunchIntent(argv: string[], cwd: string): LaunchIntent {
  const { newWindow, folderCandidates, connectServer } = parseRawLaunchArguments(argv, cwd)
  const folders = folderCandidates.filter(isExistingDirectorySync)
  return { newWindow, folders, ...(connectServer !== undefined ? { connectServer } : {}) }
}

export async function parseLaunchIntentAsync(
  argv: readonly string[],
  cwd: string,
  isDirectory?: (path: string) => Promise<boolean>,
): Promise<LaunchIntent> {
  const { newWindow, folderCandidates, connectServer } = parseRawLaunchArguments(argv, cwd)
  const checkDirectory = isDirectory ?? (() => {
    const physicalFs = resolvePhysicalFsPromises()
    return (path: string) => isExistingDirectoryAsync(path, physicalFs)
  })()
  const folders: string[] = []
  for (const candidate of folderCandidates) {
    if (await checkDirectory(candidate)) folders.push(candidate)
  }
  return { newWindow, folders, ...(connectServer !== undefined ? { connectServer } : {}) }
}

/**
 * A saved window request (Preferences) restored once the backend is ready. A connect-only launch
 * defers it: only a fallback to the normal start releases it, and it is never discarded meanwhile.
 */
export class DeferredRestore<T> {
  constructor(private pending: T | undefined, private deferred: boolean) {}

  /** The request to restore now, or nothing while deferred or already taken. */
  take(): T | undefined {
    if (this.deferred) return undefined
    const request = this.pending
    this.pending = undefined
    return request
  }

  /** A restore that failed keeps its request for the next backend navigation. */
  retry(request: T): void {
    this.pending = request
  }

  /** The launch started normally: the request restores like any startup restore. */
  release(): void {
    this.deferred = false
  }
}

const MAX_FORWARDED_FOLDERS = 64
const MAX_CONNECT_SERVER_LENGTH = 2048

/** The singleton payload a second launch sends: its own parse of its own, unreordered arguments. */
export function forwardedLaunchData(intent: LaunchIntent): { codenomadLaunchIntent: LaunchIntent } {
  return { codenomadLaunchIntent: intent }
}

function parseForwardedLaunchShape(data: unknown): LaunchIntent | undefined {
  const intent = (data as { codenomadLaunchIntent?: unknown } | null | undefined)?.codenomadLaunchIntent as Partial<LaunchIntent> | undefined
  if (!intent || typeof intent !== "object" || typeof intent.newWindow !== "boolean" || !Array.isArray(intent.folders)
    || intent.folders.length > MAX_FORWARDED_FOLDERS || !intent.folders.every((folder) => typeof folder === "string")
    || (intent.connectServer !== undefined && (typeof intent.connectServer !== "string" || intent.connectServer.length > MAX_CONNECT_SERVER_LENGTH))) {
    return undefined
  }
  return { newWindow: intent.newWindow, folders: intent.folders, ...(intent.connectServer !== undefined ? { connectServer: intent.connectServer.trim() } : {}) }
}

/** Validates a second launch's singleton payload; anything malformed falls back to parsing the forwarded argv. */
export function readForwardedLaunchIntent(data: unknown): LaunchIntent | undefined {
  const parsed = parseForwardedLaunchShape(data)
  if (!parsed) return undefined
  const folders = parsed.folders.filter((folder) => isAbsolute(folder) && isExistingDirectorySync(resolve(folder)))
  return { newWindow: parsed.newWindow, folders: [...new Set(folders)], ...(parsed.connectServer !== undefined ? { connectServer: parsed.connectServer } : {}) }
}

export async function readForwardedLaunchIntentAsync(
  data: unknown,
  isDirectory?: (path: string) => Promise<boolean>,
): Promise<LaunchIntent | undefined> {
  const parsed = parseForwardedLaunchShape(data)
  if (!parsed) return undefined
  const checkDirectory = isDirectory ?? (() => {
    const physicalFs = resolvePhysicalFsPromises()
    return (path: string) => isExistingDirectoryAsync(path, physicalFs)
  })()
  const folders: string[] = []
  const seen = new Set<string>()
  for (const folder of parsed.folders) {
    if (!isAbsolute(folder) || seen.has(folder)) continue
    if (await checkDirectory(resolve(folder))) {
      seen.add(folder)
      folders.push(folder)
    }
  }
  return { newWindow: parsed.newWindow, folders, ...(parsed.connectServer !== undefined ? { connectServer: parsed.connectServer } : {}) }
}

function shouldFocusExistingWindowOnSecondLaunch(rawConfig: string): boolean {
  try {
    const config = parseYaml(rawConfig) as any
    return config?.ui?.settings?.focusExistingWindowOnSecondLaunch === true
  } catch {
    return false
  }
}

export function prepareSecondLaunchIntent(intent: LaunchIntent, configPath: string): LaunchIntent {
  // A connection runs in an existing window; a new window would be left empty beside the remote one.
  if (isConnectOnlyLaunch(intent)) return intent
  try {
    if (shouldFocusExistingWindowOnSecondLaunch(readFileSync(configPath, "utf8"))) return intent
  } catch {}
  return intent.newWindow ? intent : { ...intent, newWindow: true }
}

export async function prepareSecondLaunchIntentAsync(
  intent: LaunchIntent,
  configPath: string,
  readConfig: (path: string) => Promise<string> = (path) => resolvePhysicalFsPromises().readFile(path, "utf8"),
): Promise<LaunchIntent> {
  // A connection runs in an existing window; a new window would be left empty beside the remote one.
  if (isConnectOnlyLaunch(intent)) return intent
  try {
    if (shouldFocusExistingWindowOnSecondLaunch(await readConfig(configPath))) return intent
  } catch {}
  return intent.newWindow ? intent : { ...intent, newWindow: true }
}

export interface ForwardedLaunchDependencies {
  isDirectory?: (path: string) => Promise<boolean>
  readConfig?: (path: string) => Promise<string>
  argvSliceIndex?: (argv: readonly string[]) => number
  fallbackCwd?: () => string
}

export function createForwardedLaunchQueue(
  configPath: string,
  enqueueIntent: (intent: LaunchIntent) => void | Promise<void>,
  reportError: (error: unknown) => void,
  dependencies: ForwardedLaunchDependencies = {},
) {
  const physicalFs = dependencies.isDirectory && dependencies.readConfig ? undefined : resolvePhysicalFsPromises()
  const isDirectory = dependencies.isDirectory ?? ((path: string) => isExistingDirectoryAsync(path, physicalFs!))
  const readConfig = dependencies.readConfig ?? ((path: string) => physicalFs!.readFile(path, "utf8"))
  const argvSliceIndex = dependencies.argvSliceIndex ?? ((argv: readonly string[]) => argv.length > 0 ? 1 : 0)
  const fallbackCwd = dependencies.fallbackCwd ?? process.cwd
  let tail = Promise.resolve()

  return {
    enqueueSecondInstance(argv: readonly string[], workingDirectory: string, additionalData: unknown): Promise<void> {
      if ((additionalData as { automationRelaunch?: unknown } | undefined)?.automationRelaunch === true) {
        return Promise.resolve()
      }
      const rawArgv = [...argv]
      const operation = tail.then(async () => {
        const intent = await readForwardedLaunchIntentAsync(additionalData, isDirectory)
          ?? await parseLaunchIntentAsync(rawArgv.slice(argvSliceIndex(rawArgv)), workingDirectory || fallbackCwd(), isDirectory)
        const prepared = await prepareSecondLaunchIntentAsync(intent, configPath, readConfig)
        void Promise.resolve(enqueueIntent(prepared)).catch(() => {})
      })
      tail = operation.catch(reportError)
      return operation
    },
    enqueueOpenFile(path: string): Promise<void> {
      const operation = tail.then(async () => {
        const intent = await parseLaunchIntentAsync([path], fallbackCwd(), isDirectory)
        if (intent.folders.length) void Promise.resolve(enqueueIntent(intent)).catch(() => {})
      })
      tail = operation.catch(reportError)
      return operation
    },
    idle: () => tail,
  }
}
