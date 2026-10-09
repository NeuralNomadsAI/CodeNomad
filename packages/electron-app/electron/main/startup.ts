import { createHash, randomUUID } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, normalize, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { resolveCrossHostStatePath, resolveLegacyCrossHostStatePath, resolveLegacyTauriDataDirectory } from "./client-state-cross-host"
import { profileDisplayName, profileScope, resolveExplicitProfile, type ExplicitProfile } from "./data-profile"
import { resolveTransitionProfile, type SelectionLock, type TransitionCandidate, type TransitionContext, type TransitionResult } from "./profile-transition"

export interface LaunchIntent {
  newWindow: boolean
  folders: string[]
}

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

export function normalizeConfigIdentity(raw: string | undefined, cwd: string): string {
  let target = raw?.trim() || "~/.config/codenomad/config.json"
  if (target === "~" || target.startsWith("~/") || target.startsWith("~\\")) {
    target = join(homedir(), target.slice(2))
  } else if (!isAbsolute(target)) {
    target = resolve(cwd, target)
  }
  target = normalize(target)
  if (/\.json$/i.test(target)) target = join(resolve(target, ".."), "config.yaml")
  if (!/\.ya?ml$/i.test(target)) target = join(target, "config.yaml")
  return process.platform === "win32" ? target.toLowerCase() : target
}

export type LaunchProfile =
  | { kind: "ready"; key: string; source: ExplicitProfile["source"] | "transition" }
  | { kind: "ask"; candidates: TransitionCandidate[]; lock: SelectionLock; context: TransitionContext }

/** Resolves the data profile before any profile path, singleton or Chromium storage is fixed. */
export function resolveLaunchProfile(options: {
  environment: Record<string, string | undefined>
  packaged: boolean
  cliConfig?: string
  cwd: string
  baseUserDataPath: string
  /** Unremembered answer handed to this relaunch by the asking process (already validated). */
  selectionAnswer?: string
  transition?: (context: TransitionContext) => TransitionResult
}): LaunchProfile {
  const explicit = resolveExplicitProfile(options.environment, options.packaged)
  if (explicit) return { kind: "ready", ...explicit }
  if (options.selectionAnswer) {
    console.info(`[electron-startup] data profile ${profileDisplayName(options.selectionAnswer)} (unremembered answer)`)
    return { kind: "ready", key: options.selectionAnswer, source: "transition" }
  }
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
  if (result.kind === "ask") return { kind: "ask", candidates: result.candidates, lock: result.lock, context }
  console.info(`[electron-startup] data profile ${profileDisplayName(result.key)} (${result.reason})`)
  return { kind: "ready", key: result.key, source: "transition" }
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

function existingDirectory(value: string, cwd: string): string | undefined {
  const candidate = resolve(cwd, value)
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined
  } catch {
    return undefined
  }
}

export function parseLaunchIntent(argv: string[], cwd: string): LaunchIntent {
  const folders: string[] = []
  let newWindow = false
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (value === "--new-window") {
      newWindow = true
      continue
    }
    if (value === "--folder") {
      const folder = argv[index + 1]
      if (folder && !folder.startsWith("-")) {
        index++
        const resolved = existingDirectory(folder, cwd)
        if (resolved) folders.push(resolved)
      }
      continue
    }
    if (value.startsWith("--folder=")) {
      const resolved = existingDirectory(value.slice("--folder=".length), cwd)
      if (resolved) folders.push(resolved)
      continue
    }
    if (value.startsWith("-")) continue
    const resolved = existingDirectory(value, cwd)
    if (resolved) folders.push(resolved)
  }
  return { newWindow, folders: [...new Set(folders)] }
}

export function prepareSecondLaunchIntent(intent: LaunchIntent, configPath: string): LaunchIntent {
  try {
    const config = parseYaml(readFileSync(configPath, "utf8")) as any
    if (config?.ui?.settings?.focusExistingWindowOnSecondLaunch === true) return intent
  } catch {}
  return intent.newWindow ? intent : { ...intent, newWindow: true }
}
