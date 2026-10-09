import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs"
import { join } from "node:path"
import { parseClientState, type ClientWindowStateRecord } from "./client-state-envelope"
import { DEFAULT_PROFILE_KEY, parseProfileName, profileDisplayName, profileScope, TRANSITION_PROFILE_KEYS } from "./data-profile"

/**
 * One-time transition for packaged launches without an explicit profile. Older builds picked
 * `dev`/`dev-v2` from their version label; we look (read-only) for restorable client state in
 * those profiles and the default one, then remember the result outside every profile. Mirrors
 * Tauri's `profile_transition.rs`.
 */
export const SELECTION_DIRECTORY = "profile-selection"
const CHOICES_FILENAME = "choices.json"
const LOCK_FILENAME = "choices.lock"
const CHOICES_VERSION = 1
const MAX_CHOICES_BYTES = 64 * 1024
const MAX_CHOICES = 256
const MAX_STATE_BYTES = 32 * 1024 * 1024
export const LOCK_HEARTBEAT_MS = 2_000
export const LOCK_STALE_MS = 15_000
const LOCK_POLL_MS = 100

export interface TransitionContext {
  configIdentity: string
  defaultIdentity: string
  /** `<appData>/CodeNomad`: parent of `scopes/` and of the selection directory. */
  userDataBase: string
  /** Default-profile client-state files in migration order (current shared file first). */
  defaultStateFiles: string[]
}

export interface TransitionCandidate {
  key: string
  name: string
  lastUsed: number
}

export type TransitionResult =
  | { kind: "resolved"; key: string; reason: "remembered" | "none" | "single" | "unremembered" }
  | { kind: "ask"; candidates: TransitionCandidate[]; lock: SelectionLock }

export interface TransitionDependencies {
  now(): number
  sleep(milliseconds: number): void
}

const blockingSleep = (milliseconds: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
const defaultDependencies: TransitionDependencies = { now: Date.now, sleep: blockingSleep }

const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException | undefined)?.code === code

function restorableRecord(record: ClientWindowStateRecord): boolean {
  if (!record.restoreEnabled) return false
  // A partitioned root always references its session partition; any further key is a workspace tab.
  if (record.partitionKeys) return record.partitionKeys.length > 1
  // Legacy monolithic snapshots: sidecar-only tabs are not restorable work, as in the partitioned branch.
  const tabs = (record.snapshot as { session?: { tabs?: unknown } } | undefined)?.session?.tabs
  return Array.isArray(tabs) && tabs.some((tab) => (tab as { kind?: unknown } | null)?.kind === "workspace")
}

/** Bounded, read-only check using the regular envelope parser; unsupported files never count. */
export function hasRestorableState(path: string): { restorable: boolean; lastUsed: number } {
  try {
    const stats = statSync(path)
    if (!stats.isFile() || stats.size > MAX_STATE_BYTES) return { restorable: false, lastUsed: 0 }
    const parsed = parseClientState(readFileSync(path, "utf8"), "00000000-0000-4000-8000-000000000000")
    const restorable = !parsed.unsupportedFutureEnvelope
      && parsed.state.windowOrder.some((id) => restorableRecord(parsed.state.windows[id]!))
    return { restorable, lastUsed: stats.mtimeMs }
  } catch {
    return { restorable: false, lastUsed: 0 }
  }
}

export function profileStateFiles(key: string, context: TransitionContext): string[] {
  const scope = profileScope(key, context.configIdentity, context.defaultIdentity)
  if (scope.scoped) return [join(context.userDataBase, "scopes", scope.scopeName, "client-state", "client-state.json")]
  // Legacy default files are migrated only while the current shared file does not exist.
  const [current, ...legacy] = context.defaultStateFiles
  return current && existsSync(current) ? [current] : legacy
}

export function detectCandidates(context: TransitionContext): TransitionCandidate[] {
  const candidates: TransitionCandidate[] = []
  for (const key of TRANSITION_PROFILE_KEYS) {
    let lastUsed = -1
    for (const file of profileStateFiles(key, context)) {
      const state = hasRestorableState(file)
      if (state.restorable) lastUsed = Math.max(lastUsed, state.lastUsed)
    }
    if (lastUsed >= 0) candidates.push({ key, name: profileDisplayName(key), lastUsed })
  }
  return candidates.sort((left, right) => right.lastUsed - left.lastUsed)
}

/**
 * Key of a remembered choice. Windows config identities are case-insensitive but each host folds
 * them differently (Electron: Unicode, Tauri: ASCII), and scope hashes must keep that historical
 * fold. The choices file is new, so its key folds Unicode case on Windows on both hosts (idempotent
 * over either host's identity) and a choice is shared even for paths such as `C:\Users\Émile`. No
 * folder depends on this key. Other platforms keep case-sensitive identities.
 */
export const choiceKey = (configIdentity: string, platform: NodeJS.Platform = process.platform) =>
  createHash("sha256").update(platform === "win32" ? configIdentity.toLowerCase() : configIdentity).digest("hex")

type ChoicesFile =
  | { status: "absent" | "corrupt"; choices: Record<string, string> }
  | { status: "valid"; choices: Record<string, string> }
  | { status: "future" }

export function readChoices(directory: string): ChoicesFile {
  let text: string
  try {
    const path = join(directory, CHOICES_FILENAME)
    if (statSync(path).size > MAX_CHOICES_BYTES) return { status: "corrupt", choices: {} }
    text = readFileSync(path, "utf8")
  } catch (error) {
    return { status: hasCode(error, "ENOENT") ? "absent" : "corrupt", choices: {} }
  }
  try {
    const value = JSON.parse(text) as { version?: unknown; choices?: unknown }
    if (typeof value?.version === "number" && Number.isInteger(value.version) && value.version > CHOICES_VERSION) return { status: "future" }
    if (value?.version !== CHOICES_VERSION || !value.choices || typeof value.choices !== "object" || Array.isArray(value.choices)) {
      return { status: "corrupt", choices: {} }
    }
    // Keys are validated SHA-256 hex digests, so a plain object cannot be polluted.
    const choices: Record<string, string> = {}
    for (const [key, name] of Object.entries(value.choices).slice(0, MAX_CHOICES)) {
      if (!/^[0-9a-f]{64}$/.test(key) || typeof name !== "string") continue
      try { parseProfileName(name) } catch { continue }
      choices[key] = name
    }
    return { status: "valid", choices }
  } catch {
    return { status: "corrupt", choices: {} }
  }
}

/**
 * A remembered named profile must still exist for this configuration: both hosts create
 * `scopes/<scope>` under the userData base when they open a scoped profile (Electron's userData,
 * Tauri's client-state). A deleted one is ignored so detection runs again instead of silently
 * opening an empty profile. The default profile always exists.
 *
 * Unlike deletion, which never follows links, this check follows a symlink/junction: the hosts open
 * a relocated profile through it. Three outcomes, shared with Tauri through the
 * `rememberedProfileStates` vectors:
 * - `present`: a folder, also through a link; an unreadable entry or any other error keeps the choice.
 * - `missing`: a definite absence of a plain entry (not found, not a directory). Detection reruns and
 *   its result replaces the remembered choice.
 * - `unavailable`: the entry is a link whose target is missing or not a folder, e.g. a disconnected
 *   removable or network drive. Detection reruns for this launch only; the choice is kept, so the
 *   profile is used again once its target returns.
 */
export type RememberedProfileState = "present" | "missing" | "unavailable"

export interface ProfileFolderProbe {
  lstat(path: string): { isSymbolicLink(): boolean }
  stat(path: string): { isDirectory(): boolean }
}

const systemProbe: ProfileFolderProbe = { lstat: lstatSync, stat: statSync }
const isAbsent = (error: unknown) => hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")

export function rememberedProfileState(
  key: string,
  context: Pick<TransitionContext, "configIdentity" | "defaultIdentity" | "userDataBase">,
  probe: ProfileFolderProbe = systemProbe,
): RememberedProfileState {
  if (key === DEFAULT_PROFILE_KEY) return "present"
  const scope = profileScope(key, context.configIdentity, context.defaultIdentity)
  if (!scope.scoped) return "present"
  const path = join(context.userDataBase, "scopes", scope.scopeName)
  let link: boolean
  try {
    link = probe.lstat(path).isSymbolicLink()
  } catch (error) {
    return isAbsent(error) ? "missing" : "present"
  }
  const unusable = link ? "unavailable" : "missing"
  try {
    return probe.stat(path).isDirectory() ? "present" : unusable
  } catch (error) {
    return isAbsent(error) ? unusable : "present"
  }
}

function rememberedKey(directory: string, context: TransitionContext): string | undefined {
  const file = readChoices(directory)
  const name = file.status === "future" ? undefined : file.choices[choiceKey(context.configIdentity)]
  if (name === undefined) return undefined
  const key = parseProfileName(name)
  return rememberedProfileState(key, context) === "present" ? key : undefined
}

/**
 * Stores the profile name (never a path); a valid existing choice for this config is never replaced,
 * unless it names a profile that is definitely missing for this config (an unavailable linked
 * profile keeps its choice, so that launch is unremembered). Remembering is best effort: an
 * I/O failure (antivirus EPERM/EBUSY, full disk, read-only profile) only means the transition runs
 * again next launch, so it never prevents startup.
 */
function writeChoice(directory: string, context: TransitionContext, key: string): boolean {
  const file = readChoices(directory)
  if (file.status === "future") return false
  const id = choiceKey(context.configIdentity)
  const existing = file.choices[id]
  if (existing !== undefined && rememberedProfileState(parseProfileName(existing), context) !== "missing") return false
  // Replacing this config's stale entry never grows the file; only a new entry needs room.
  if (existing === undefined && Object.keys(file.choices).length >= MAX_CHOICES) return false
  try {
    writeChoicesFile(directory, { ...file.choices, [id]: profileDisplayName(key) })
    return true
  } catch (error) {
    console.warn("[profile-transition] failed to remember the profile choice", error)
    return false
  }
}

/** Atomic replacement: exclusive temporary file, fsync, rename. */
function writeChoicesFile(directory: string, choices: Record<string, string>): void {
  const temporary = join(directory, `.${CHOICES_FILENAME}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const descriptor = openSync(temporary, "wx", 0o600)
    try {
      writeSync(descriptor, `${JSON.stringify({ version: CHOICES_VERSION, choices }, null, 2)}\n`)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, join(directory, CHOICES_FILENAME))
  } finally {
    try { rmSync(temporary, { force: true }) } catch {}
  }
}

export type ForgetChoicesOutcome = "updated" | "unchanged" | "busy" | "failed"

export interface ForgottenChoices {
  /** Forgotten for every configuration. */
  names: readonly string[]
  /** Forgotten only for one configuration: `key` is its choice key, `name` the deleted profile. */
  entries: ReadonlyArray<{ key: string; name: string }>
}

/**
 * Drops remembered choices that name deleted profiles, under the selection lock. A held lock
 * (a launch is choosing right now) leaves the file untouched; a newer or corrupt file is never
 * rewritten. The next launch for an affected config then runs the transition again.
 */
export function forgetChoices(directory: string, forgotten: ForgottenChoices, now: () => number = Date.now): ForgetChoicesOutcome {
  if ((!forgotten.names.length && !forgotten.entries.length) || !existsSync(join(directory, CHOICES_FILENAME))) return "unchanged"
  let lock: SelectionLock | undefined
  try {
    lock = SelectionLock.tryAcquire(directory, now)
  } catch {
    return "failed"
  }
  if (!lock) return "busy"
  try {
    const file = readChoices(directory)
    if (file.status !== "valid") return "unchanged"
    const names = new Set(forgotten.names)
    const drop = (key: string, name: string) =>
      names.has(name) || forgotten.entries.some((entry) => entry.key === key && entry.name === name)
    const kept = Object.fromEntries(Object.entries(file.choices).filter(([key, name]) => !drop(key, name)))
    if (Object.keys(kept).length === Object.keys(file.choices).length) return "unchanged"
    writeChoicesFile(directory, kept)
    return "updated"
  } catch (error) {
    console.warn("[profile-transition] failed to forget deleted profile choices", error)
    return "failed"
  } finally {
    lock.release()
  }
}

/**
 * Cross-process selection lock: exclusive create, kept alive by heartbeats, stolen only when stale.
 * When the lock cannot be used at all (I/O errors other than contention), detection, which is
 * read-only, proceeds without it: concurrent first launches may then each ask, and the first
 * remembered answer wins for later launches.
 */
export class SelectionLock {
  private released = false
  private constructor(readonly directory: string, readonly token: string | undefined) {}

  /** A lock that guards nothing; used only when the lock file itself is unusable. */
  static unguarded(directory: string): SelectionLock {
    return new SelectionLock(directory, undefined)
  }

  static tryAcquire(directory: string, now: () => number): SelectionLock | undefined {
    const path = join(directory, LOCK_FILENAME)
    const token = randomUUID()
    try {
      const descriptor = openSync(path, "wx", 0o600)
      try { writeSync(descriptor, JSON.stringify({ pid: process.pid, token })) } finally { closeSync(descriptor) }
      return new SelectionLock(directory, token)
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error
    }
    let observed: string
    try {
      if (now() - statSync(path).mtimeMs <= LOCK_STALE_MS) return undefined
      observed = readFileSync(path, "utf8")
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined
      throw error
    }
    // Move the stale lock aside atomically; restore it if a fresh holder replaced it meanwhile.
    // Accepted race (no cross-host primitive closes it): if a third launcher creates a new lock
    // between our rename and the restoring link, the link fails and two holders may both ask. The
    // outcome is bounded: the first remembered answer wins, the other applies to its launch only.
    const aside = join(directory, `${LOCK_FILENAME}.stale-${token}`)
    try { renameSync(path, aside) } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error }
    try {
      if (readFileSync(aside, "utf8") !== observed) { try { linkSync(aside, path) } catch {} }
    } finally {
      rmSync(aside, { force: true })
    }
    return undefined
  }

  heartbeat(): void {
    if (this.released || this.token === undefined) return
    const time = new Date()
    try { utimesSync(join(this.directory, LOCK_FILENAME), time, time) } catch {}
  }

  release(): void {
    if (this.released) return
    this.released = true
    if (this.token === undefined) return
    const path = join(this.directory, LOCK_FILENAME)
    try {
      if (JSON.parse(readFileSync(path, "utf8")).token === this.token) rmSync(path, { force: true })
    } catch {}
  }

  /** Records the user's answer while still holding the lock; false when it could not be remembered. */
  commit(context: TransitionContext, key: string): boolean {
    return writeChoice(this.directory, context, key)
  }
}

export function selectionDirectory(userDataBase: string): string {
  return join(userDataBase, SELECTION_DIRECTORY)
}

export function resolveTransitionProfile(
  context: TransitionContext,
  dependencies: TransitionDependencies = defaultDependencies,
): TransitionResult {
  const directory = selectionDirectory(context.userDataBase)
  const remembered = rememberedKey(directory, context)
  if (remembered !== undefined) return { kind: "resolved", key: remembered, reason: "remembered" }
  let lockUsable = true
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    console.warn("[profile-transition] selection directory unavailable; continuing without remembering", error)
    lockUsable = false
  }
  // Concurrent first launches wait here: only the lock holder detects, asks and records.
  for (;;) {
    let lock: SelectionLock | undefined
    try {
      lock = lockUsable ? SelectionLock.tryAcquire(directory, dependencies.now) : SelectionLock.unguarded(directory)
    } catch (error) {
      console.warn("[profile-transition] selection lock unavailable; continuing unguarded", error)
      lock = SelectionLock.unguarded(directory)
    }
    if (!lock) {
      dependencies.sleep(LOCK_POLL_MS)
      const decided = rememberedKey(directory, context)
      if (decided !== undefined) return { kind: "resolved", key: decided, reason: "remembered" }
      continue
    }
    try {
      const decided = rememberedKey(directory, context)
      if (decided !== undefined) {
        lock.release()
        return { kind: "resolved", key: decided, reason: "remembered" }
      }
      const candidates = detectCandidates(context)
      if (candidates.length > 1) return { kind: "ask", candidates, lock }
      const key = candidates[0]?.key ?? DEFAULT_PROFILE_KEY
      const stored = writeChoice(directory, context, key)
      lock.release()
      return { kind: "resolved", key, reason: !stored ? "unremembered" : candidates.length ? "single" : "none" }
    } catch (error) {
      lock.release()
      throw error
    }
  }
}
