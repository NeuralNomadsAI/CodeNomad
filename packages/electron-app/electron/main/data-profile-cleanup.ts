import { createHash } from "node:crypto"
import { lstat, readdir, readFile, readlink, rm, unlink } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { basename, dirname, join, posix, resolve, win32 } from "node:path"
import { isPidAlive } from "./client-state-process"
import { DEFAULT_PROFILE_KEY, profileDisplayName, profileScope } from "./data-profile"
import { choiceKey, forgetChoices, selectionDirectory, type ForgetChoicesOutcome } from "./profile-transition"

/**
 * Lists and deletes the desktop data profiles other than the open one (see
 * dev-docs/DESKTOP_DATA_PROFILES.md). Mirrored by Tauri's `data_profile_cleanup.rs`; both hosts
 * enumerate the same folders and apply the same in-use rules, because a profile can be open in
 * either host. The renderer only ever sends IDs returned by the listing: every deletion
 * re-enumerates, re-validates and rechecks activity host-side. Only direct children of known roots
 * with the expected names are removed, never through a symlink or junction, and never a root.
 */
export const TAURI_IDENTIFIER = "ai.neuralnomads.codenomad.client"
const TAURI_SCOPE_PREFIX = `${TAURI_IDENTIFIER}.scope.s`
const SCOPE_NAME = /^([a-z0-9._-]{1,200})-([0-9a-f]{16})$/
const TAURI_SCOPE_NAME = /^ai\.neuralnomads\.codenomad\.client\.scope\.s([0-9a-f]{16})$/
const ELECTRON_MARKER = /^client-state\.running\.(\d+)\..+\.json$/
const TAURI_MARKER = /^client-state\.running\.(\d+)\..+\.lock$/
const MAX_SCOPE_ENTRIES = 512
const MAX_DIRECTORY_ENTRIES = 10_000
const MAX_SIZE_ENTRIES = 20_000
const MAX_SIZE_DEPTH = 32
const MAX_KEPT_REPORTED = 32

/** Default-profile children each host creates; anything else is kept and reported. */
const DEFAULT_ELECTRON_CHILDREN = { directories: ["developer-mode-browser-v2"], files: ["client-state.json"] }
const DEFAULT_WEBVIEW_CHILDREN = ["developer-mode", "local", "remote", "browser"]
const ELECTRON_BOOKKEEPING = new Set([
  "scopes", "profile-selection", "client-state.primary.lock", "client-state.registration.lock",
  "lockfile", "SingletonLock", "SingletonSocket", "SingletonCookie",
])
const TAURI_BOOKKEEPING = new Set(["client-state.primary.lock", "client-state.registration.lock", "client-state.registration.owner", ".cross-host-election"])

export interface ProfileRoots {
  /** `<appData>/CodeNomad`: Electron's default userData, parent of `scopes/` and `profile-selection/`. */
  electronBase: string
  /** `<localData>/ai.neuralnomads.codenomad.client-v2`: Tauri's default WebView data, parent of `scopes/`. */
  webviewRoot: string
  /** Parent of Tauri's app data directories (`<identifier>` and `<identifier>.scope.s<hash>`). */
  tauriDataParent: string
  /** `~/.codenomad/client-state`: the default profile's shared client state (`v2/`) and its legacy file. */
  homeClientState: string
}

export interface CurrentProfile {
  key: string
  configIdentity: string
  defaultIdentity: string
}

export type OtherProfileKind = "scope" | "default" | "orphan"
export type OtherProfileStatus = "available" | "in-use" | "unknown"

export interface OtherProfile {
  id: string
  kind: OtherProfileKind
  /** Profile name as used with CODENOMAD_PROFILE (`default` for the default profile); lock-folder hash for orphans. */
  name: string
  /** True when the profile belongs to another CodeNomad configuration file than the open one. */
  otherConfiguration: boolean
  sizeBytes: number
  /** False when the bounded size walk stopped early; sizeBytes is then a lower bound. */
  sizeComplete: boolean
  status: OtherProfileStatus
}

export interface OtherProfilesListing {
  profiles: OtherProfile[]
  /**
   * macOS only: Tauri keeps web storage in WebKit's store, shared by every scoped profile (one fixed
   * data-store identifier) or WebKit's default store for the default profile. No profile owns it,
   * so it is never deleted and the confirmation must say so.
   */
  sharedWebKitStorage: boolean
}

export type DeletionOutcome = "deleted" | "incomplete" | "in-use" | "unknown" | "missing"

export interface ProfileDeletion {
  id: string
  name: string
  outcome: DeletionOutcome
  /** Paths of this profile that still exist afterwards. */
  remaining: string[]
  /** Unrecognized default-profile entries that were deliberately left in place. */
  kept: string[]
}

export interface DeleteOtherProfilesResult {
  results: ProfileDeletion[]
  choices: ForgetChoicesOutcome
}

interface Target { root: string; name: string; directory: boolean }

interface ActivityProbe {
  electronData?: string
  election?: string
  tauriData?: string
  webview?: string
}

interface Candidate extends Omit<OtherProfile, "sizeBytes" | "sizeComplete" | "status"> {
  key?: string
  targets: Target[]
  probe: ActivityProbe
  keptRoots: Array<{ root: string; ignore: ReadonlySet<string> }>
}

export interface CleanupDependencies {
  pidAlive(pid: number): boolean
  now(): number
  /** Entries visited per profile when measuring its size. */
  sizeEntries?: number
  remove?(path: string, directory: boolean): Promise<void>
  /** Host name compared with Chromium's POSIX `SingletonLock` target. */
  hostname?(): string
  platform?: NodeJS.Platform
}

const removePath = (path: string, directory: boolean) =>
  directory ? rm(path, { recursive: true, force: false, maxRetries: 2 }) : unlink(path)

const defaultDependencies: CleanupDependencies = { pidAlive: isPidAlive, now: Date.now }

const hasCode = (error: unknown, ...codes: string[]) => codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? "")

/** Names in a folder (bounded); shared roots such as `%APPDATA%` hold many unrelated entries, so callers filter before capping. */
async function entries(directory: string): Promise<string[] | undefined> {
  try { return (await readdir(directory)).slice(0, MAX_DIRECTORY_ENTRIES) } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) return []
    return undefined
  }
}

async function plainDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { return !hasCode(error, "ENOENT", "ENOTDIR") }
}

const scopeSuffix = (key: string, configIdentity: string) => createHash("sha256").update(`${key}\0${configIdentity}`).digest("hex").slice(0, 16)

/** Scope folders named `<key>-<hash>` under a `scopes/` root; nothing is returned through a link. */
async function scopeNames(root: string): Promise<Set<string>> {
  const names = new Set<string>()
  if (!await plainDirectory(root)) return names
  for (const name of await entries(root) ?? []) {
    if (names.size >= MAX_SCOPE_ENTRIES) break
    if (SCOPE_NAME.test(name) && await plainDirectory(join(root, name))) names.add(name)
  }
  return names
}

async function candidates(roots: ProfileRoots, current: CurrentProfile): Promise<Candidate[]> {
  const currentScope = profileScope(current.key, current.configIdentity, current.defaultIdentity)
  const electronScopes = join(roots.electronBase, "scopes")
  const webviewScopes = join(roots.webviewRoot, "scopes")
  const [electronNames, webviewNames] = await Promise.all([scopeNames(electronScopes), scopeNames(webviewScopes)])
  const scopes = new Set([...electronNames, ...webviewNames])
  if (currentScope.scoped) scopes.delete(currentScope.scopeName)
  const tauriScopes = new Set<string>()
  for (const name of await entries(roots.tauriDataParent) ?? []) {
    if (tauriScopes.size >= MAX_SCOPE_ENTRIES) break
    const match = TAURI_SCOPE_NAME.exec(name)
    if (match && await plainDirectory(join(roots.tauriDataParent, name))) tauriScopes.add(match[1]!)
  }
  const result: Candidate[] = []
  const claimedSuffixes = new Set(currentScope.scoped ? [currentScope.suffix] : [])
  for (const scopeName of [...scopes].sort()) {
    const [, key, suffix] = SCOPE_NAME.exec(scopeName)!
    claimedSuffixes.add(suffix!)
    const targets: Target[] = []
    if (electronNames.has(scopeName)) targets.push({ root: electronScopes, name: scopeName, directory: true })
    if (webviewNames.has(scopeName)) targets.push({ root: webviewScopes, name: scopeName, directory: true })
    const tauriName = `${TAURI_SCOPE_PREFIX}${suffix}`
    if (tauriScopes.has(suffix!)) targets.push({ root: roots.tauriDataParent, name: tauriName, directory: true })
    const electronData = join(electronScopes, scopeName)
    result.push({
      id: `scope:${scopeName}`,
      kind: "scope",
      key: key!,
      name: profileDisplayName(key!),
      otherConfiguration: scopeSuffix(key!, current.configIdentity) !== suffix,
      targets,
      probe: { electronData, election: join(electronData, "client-state", "election"), tauriData: join(roots.tauriDataParent, tauriName), webview: join(webviewScopes, scopeName) },
      keptRoots: [],
    })
  }
  for (const suffix of [...tauriScopes].sort()) {
    if (claimedSuffixes.has(suffix)) continue
    const name = `${TAURI_SCOPE_PREFIX}${suffix}`
    result.push({
      id: `orphan:${suffix}`,
      kind: "orphan",
      name: `s${suffix}`,
      otherConfiguration: false,
      targets: [{ root: roots.tauriDataParent, name, directory: true }],
      probe: { tauriData: join(roots.tauriDataParent, name) },
      keptRoots: [],
    })
  }
  if (currentScope.scoped) {
    const defaultCandidate = await defaultProfileCandidate(roots, current)
    if (defaultCandidate) result.unshift(defaultCandidate)
  }
  return result
}

/** The default profile owns its roots' own children only; `scopes/` and the selection folder are never its data. */
async function defaultProfileCandidate(roots: ProfileRoots, current: CurrentProfile): Promise<Candidate | undefined> {
  const tauriDefault = join(roots.tauriDataParent, TAURI_IDENTIFIER)
  const sharedState = join(roots.homeClientState, "v2")
  const planned: Target[] = [
    ...DEFAULT_ELECTRON_CHILDREN.directories.map((name) => ({ root: roots.electronBase, name, directory: true })),
    ...DEFAULT_ELECTRON_CHILDREN.files.map((name) => ({ root: roots.electronBase, name, directory: false })),
    { root: sharedState, name: "client-state.json", directory: false },
    { root: sharedState, name: "partitions", directory: true },
    { root: roots.homeClientState, name: "client-state.json", directory: false },
    ...DEFAULT_WEBVIEW_CHILDREN.map((name) => ({ root: roots.webviewRoot, name, directory: true })),
    { root: tauriDefault, name: "client-state.json", directory: false },
  ]
  const targets: Target[] = []
  for (const target of planned) if (await exists(join(target.root, target.name))) targets.push(target)
  if (!targets.length) return undefined
  const owned = (root: string) => new Set(targets.filter((target) => target.root === root).map((target) => target.name))
  return {
    id: "default",
    kind: "default",
    key: DEFAULT_PROFILE_KEY,
    name: profileDisplayName(DEFAULT_PROFILE_KEY),
    otherConfiguration: current.configIdentity !== current.defaultIdentity,
    targets,
    probe: { electronData: roots.electronBase, election: join(sharedState, "election"), tauriData: tauriDefault, webview: roots.webviewRoot },
    keptRoots: [
      { root: roots.electronBase, ignore: new Set([...ELECTRON_BOOKKEEPING, ...owned(roots.electronBase)]) },
      { root: roots.webviewRoot, ignore: new Set(["scopes", ...owned(roots.webviewRoot)]) },
      { root: sharedState, ignore: new Set(["election", ...owned(sharedState)]) },
      { root: tauriDefault, ignore: new Set([...TAURI_BOOKKEEPING, ...owned(tauriDefault)]) },
    ],
  }
}

/** Entries of the default profile's roots that no host code identifies; reported, never deleted. */
async function keptEntries(candidate: Candidate): Promise<string[]> {
  const kept: string[] = []
  for (const { root, ignore } of candidate.keptRoots) {
    for (const name of await entries(root) ?? []) {
      if (ignore.has(name) || name.startsWith("client-state.running.") || name.startsWith(".client-state.running.")) continue
      if (kept.length < MAX_KEPT_REPORTED) kept.push(join(root, name))
    }
  }
  return kept
}

export type Activity = "idle" | "in-use" | "unknown"

function combine(left: Activity, right: Activity): Activity {
  return left === "in-use" || right === "in-use" ? "in-use" : left === "unknown" || right === "unknown" ? "unknown" : "idle"
}

function ownerPid(text: string): number | undefined {
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid
    return Number.isInteger(pid) && (pid as number) > 0 ? pid as number : undefined
  } catch {
    return undefined
  }
}

async function ownerFileActivity(path: string, dependencies: CleanupDependencies): Promise<Activity> {
  let text: string
  try { text = await readFile(path, "utf8") } catch (error) { return hasCode(error, "ENOENT", "ENOTDIR") ? "idle" : "unknown" }
  const pid = ownerPid(text)
  return pid === undefined ? "unknown" : dependencies.pidAlive(pid) ? "in-use" : "idle"
}

/** Markers carry the owning PID in their name; a live PID (even a reused one) counts as in use. */
async function markerActivity(directory: string, pattern: RegExp, dependencies: CleanupDependencies): Promise<Activity> {
  const names = await entries(directory)
  if (!names) return "unknown"
  let activity: Activity = "idle"
  for (const name of names) {
    if (!name.startsWith("client-state.running.")) continue
    const match = pattern.exec(name)
    activity = combine(activity, match ? dependencies.pidAlive(Number(match[1])) ? "in-use" : "idle" : "unknown")
  }
  return activity
}

/**
 * Electron's `requestSingleInstanceLock()` runs while userData is still the profile folder (main.ts
 * switches Chromium storage to `developer-mode-browser-v2` only afterwards), so Chromium's process
 * singleton lives directly in the profile folder. Windows: `lockfile`, opened delete-on-close, so it
 * exists only while held. POSIX: `SingletonLock` is a (dangling) symlink to `<hostname>-<pid>`;
 * `SingletonSocket`/`SingletonCookie` accompany it and carry no ownership. A lock of this host with a
 * live PID is in use, with a dead PID is stale; another host's lock or an unreadable one is unknown.
 */
export async function chromiumSingletonActivity(directory: string, dependencies: CleanupDependencies): Promise<Activity> {
  if (await exists(join(directory, "lockfile"))) return "in-use"
  let link: string
  try { link = await readlink(join(directory, "SingletonLock")) } catch (error) {
    return hasCode(error, "ENOENT", "ENOTDIR") ? "idle" : "unknown"
  }
  const separator = link.lastIndexOf("-")
  const host = link.slice(0, separator)
  const pid = link.slice(separator + 1)
  if (separator <= 0 || !/^\d+$/.test(pid) || host !== (dependencies.hostname ?? hostname)()) return "unknown"
  return dependencies.pidAlive(Number(pid)) ? "in-use" : "idle"
}

async function electionActivity(directory: string, dependencies: CleanupDependencies): Promise<Activity> {
  let activity = await ownerFileActivity(join(directory, "primary.owner.json", "owner.json"), dependencies)
  const names = await entries(directory)
  if (!names) return "unknown"
  for (const name of names) {
    if (name.startsWith("participant.") && name.endsWith(".json")) {
      activity = combine(activity, await ownerFileActivity(join(directory, name), dependencies))
    }
  }
  return activity
}

/** Electron or Tauri may hold the profile: Electron markers/locks and Chromium singleton, the cross-host election, Tauri markers and WebView2 locks. */
async function probeActivity(probe: ActivityProbe, dependencies: CleanupDependencies): Promise<Activity> {
  const checks: Array<Promise<Activity>> = []
  if (probe.electronData) {
    checks.push(markerActivity(probe.electronData, ELECTRON_MARKER, dependencies))
    checks.push(ownerFileActivity(join(probe.electronData, "client-state.primary.lock"), dependencies))
    checks.push(ownerFileActivity(join(probe.electronData, "client-state.registration.lock"), dependencies))
    checks.push(chromiumSingletonActivity(probe.electronData, dependencies))
  }
  if (probe.election) checks.push(electionActivity(probe.election, dependencies))
  if (probe.tauriData) checks.push(markerActivity(probe.tauriData, TAURI_MARKER, dependencies))
  if (probe.webview) {
    for (const nested of [["developer-mode", "local"], ["local"], []]) {
      checks.push(exists(join(probe.webview, ...nested, "EBWebView", "lockfile")).then((held) => held ? "in-use" : "idle"))
    }
  }
  return (await Promise.all(checks)).reduce(combine, "idle")
}

/** Bounded walk over lstat results; links are counted as entries, never followed. */
async function measure(targets: Target[], limit = MAX_SIZE_ENTRIES): Promise<{ bytes: number; complete: boolean }> {
  let bytes = 0
  let budget = limit
  let complete = true
  const walk = async (path: string, depth: number): Promise<void> => {
    if (budget-- <= 0) { complete = false; return }
    let stats
    try { stats = await lstat(path) } catch { return }
    if (!stats.isDirectory() || stats.isSymbolicLink()) { bytes += stats.size; return }
    if (depth >= MAX_SIZE_DEPTH) { complete = false; return }
    let names: string[]
    try { names = await readdir(path) } catch { complete = false; return }
    for (const name of names) {
      await walk(join(path, name), depth + 1)
      if (budget <= 0) { complete = false; return }
    }
  }
  for (const target of targets) await walk(join(target.root, target.name), 0)
  return { bytes, complete }
}

export async function listOtherProfiles(
  roots: ProfileRoots,
  current: CurrentProfile,
  dependencies: CleanupDependencies = defaultDependencies,
): Promise<OtherProfilesListing> {
  const profiles: OtherProfile[] = []
  for (const candidate of await candidates(roots, current)) {
    const [size, activity] = await Promise.all([measure(candidate.targets, dependencies.sizeEntries), probeActivity(candidate.probe, dependencies)])
    profiles.push({
      id: candidate.id,
      kind: candidate.kind,
      name: candidate.name,
      otherConfiguration: candidate.otherConfiguration,
      sizeBytes: size.bytes,
      sizeComplete: size.complete,
      status: activity === "idle" ? "available" : activity,
    })
  }
  return { profiles, sharedWebKitStorage: (dependencies.platform ?? process.platform) === "darwin" }
}

/** A target is removable only as a plain, link-free direct child of a link-free root with the planned name. */
async function validTarget(target: Target): Promise<boolean> {
  const root = resolve(target.root)
  const path = join(root, target.name)
  if (dirname(path) !== root || basename(path) !== target.name || target.name === "." || target.name === "..") return false
  if (!await plainDirectory(root)) return false
  try {
    const stats = await lstat(path)
    return !stats.isSymbolicLink() && (target.directory ? stats.isDirectory() : stats.isFile())
  } catch {
    return false
  }
}

async function deleteCandidate(candidate: Candidate, dependencies: CleanupDependencies): Promise<ProfileDeletion> {
  const report = (outcome: DeletionOutcome, remaining: string[] = [], kept: string[] = []): ProfileDeletion =>
    ({ id: candidate.id, name: candidate.name, outcome, remaining, kept })
  const initial = await probeActivity(candidate.probe, dependencies)
  if (initial !== "idle") return report(initial)
  const kept = candidate.kind === "default" ? await keptEntries(candidate) : []
  const remaining: string[] = []
  let stopped: Exclude<Activity, "idle"> | undefined
  for (const target of candidate.targets) {
    const path = join(target.root, target.name)
    // Recheck immediately before each removal: the profile may have been opened meanwhile.
    if (!stopped) {
      const activity = await probeActivity(candidate.probe, dependencies)
      if (activity !== "idle") stopped = activity
    }
    if (!stopped && await validTarget(target)) {
      try {
        await (dependencies.remove ?? removePath)(path, target.directory)
      } catch (error) {
        console.warn("[data-profiles] failed to remove", path, error)
      }
    }
    if (await exists(path)) remaining.push(path)
  }
  if (!remaining.length) return report("deleted", [], kept)
  return report(stopped && remaining.length === candidate.targets.length ? stopped : "incomplete", remaining, kept)
}

async function keysStillPresent(roots: ProfileRoots): Promise<Set<string>> {
  const names = new Set([...await scopeNames(join(roots.electronBase, "scopes")), ...await scopeNames(join(roots.webviewRoot, "scopes"))])
  return new Set([...names].map((name) => SCOPE_NAME.exec(name)![1]!))
}

export async function deleteOtherProfiles(
  roots: ProfileRoots,
  current: CurrentProfile,
  ids: readonly string[],
  dependencies: CleanupDependencies = defaultDependencies,
): Promise<DeleteOtherProfilesResult> {
  const requested = new Set(ids)
  const fresh = new Map((await candidates(roots, current)).map((candidate) => [candidate.id, candidate]))
  const results: ProfileDeletion[] = []
  const deletedKeys = new Set<string>()
  const currentChoice = choiceKey(current.configIdentity)
  const currentEntries: Array<{ key: string; name: string }> = []
  for (const id of requested) {
    const candidate = fresh.get(id)
    if (!candidate) {
      results.push({ id, name: id, outcome: "missing", remaining: [], kept: [] })
      continue
    }
    const result = await deleteCandidate(candidate, dependencies)
    results.push(result)
    if (result.outcome !== "deleted" || candidate.kind !== "scope" || !candidate.key || candidate.key === DEFAULT_PROFILE_KEY) continue
    deletedKeys.add(candidate.key)
    // The open configuration's choice key is known: a choice naming the profile just deleted for it goes.
    if (!candidate.otherConfiguration) currentEntries.push({ key: currentChoice, name: profileDisplayName(candidate.key) })
  }
  // Other configurations' keys cannot be mapped back to a scope: their choice of a name is forgotten
  // only when no folder of that profile remains for any configuration.
  const present = deletedKeys.size ? await keysStillPresent(roots) : new Set<string>()
  const names = [...deletedKeys].filter((key) => !present.has(key)).map(profileDisplayName)
  const choices = forgetChoices(selectionDirectory(roots.electronBase), { names, entries: currentEntries }, dependencies.now)
  return { results, choices }
}

export function requireProfileIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_ENTRIES) throw new Error("Invalid profile list")
  const ids = value.map((id) => {
    if (typeof id !== "string" || id.length > 256 || !/^(default|scope:[a-z0-9._-]+-[0-9a-f]{16}|orphan:[0-9a-f]{16})$/.test(id)) {
      throw new Error("Invalid profile identifier")
    }
    return id
  })
  return [...new Set(ids)]
}

function validHome(value: string | undefined, platform: NodeJS.Platform): string | undefined {
  if (!value) return undefined
  return (platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) : posix.isAbsolute(value)) ? value : undefined
}

/** Roots used by both hosts, resolved the way each host resolves its own folders. */
export function resolveProfileRoots(
  electronBase: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fallbackHome = homedir(),
): ProfileRoots {
  const path = platform === "win32" ? win32 : posix
  const home = (platform === "win32" ? validHome(environment.USERPROFILE, platform) ?? validHome(environment.HOME, platform) : validHome(environment.HOME, platform)) ?? fallbackHome
  const xdgData = validHome(environment.XDG_DATA_HOME, platform) ?? path.join(home, ".local", "share")
  const localData = platform === "win32"
    ? validHome(environment.LOCALAPPDATA, platform) ?? path.join(home, "AppData", "Local")
    : platform === "darwin" ? path.join(home, "Library", "Application Support") : xdgData
  const roamingData = platform === "win32"
    ? validHome(environment.APPDATA, platform) ?? path.join(home, "AppData", "Roaming")
    : platform === "darwin" ? path.join(home, "Library", "Application Support") : xdgData
  return {
    electronBase,
    webviewRoot: path.join(localData, `${TAURI_IDENTIFIER}-v2`),
    tauriDataParent: roamingData,
    homeClientState: path.join(home, ".codenomad", "client-state"),
  }
}
