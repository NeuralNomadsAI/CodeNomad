import { createHash, randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, normalize, resolve } from "node:path"

export interface LaunchIntent {
  newWindow: boolean
  folders: string[]
}

export interface StorageScope {
  channel: string
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

function normalizeConfigIdentity(raw: string | undefined, cwd: string): string {
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

export function resolveUpdateChannel(environmentChannel: string | undefined, appVersion: string, packaged: boolean): string {
  const explicit = environmentChannel?.trim().toLowerCase()
  if (explicit) return explicit.replace(/[^a-z0-9._-]+/g, "-")
  if (!packaged) return "dev"
  if (/-dev-v2(?:-|$)/i.test(appVersion)) return "dev-v2"
  return /-dev(?:\.|-)/i.test(appVersion) ? "dev" : "stable"
}

export function resolveStorageScope(options: {
  appVersion: string
  environmentChannel?: string
  cliConfig?: string
  cwd: string
  baseUserDataPath: string
  packaged: boolean
}): StorageScope {
  const channel = resolveUpdateChannel(options.environmentChannel, options.appVersion, options.packaged)
  const configIdentity = normalizeConfigIdentity(options.cliConfig, options.cwd)
  const defaultIdentity = normalizeConfigIdentity(undefined, options.cwd)
  const scoped = channel !== "stable" || configIdentity !== defaultIdentity
  const suffix = createHash("sha256").update(`${channel}\0${configIdentity}`).digest("hex").slice(0, 16)
  const userDataPath = scoped ? join(options.baseUserDataPath, "scopes", `${channel}-${suffix}`) : options.baseUserDataPath
  return {
    channel,
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
