import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs"
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
  const tabs = (record.snapshot as { session?: { tabs?: unknown } } | undefined)?.session?.tabs
  return Array.isArray(tabs) && tabs.length > 0
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

export const choiceKey = (configIdentity: string) => createHash("sha256").update(configIdentity).digest("hex")

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

function rememberedKey(directory: string, configIdentity: string): string | undefined {
  const file = readChoices(directory)
  const name = file.status === "future" ? undefined : file.choices[choiceKey(configIdentity)]
  return name === undefined ? undefined : parseProfileName(name)
}

/** Stores the profile name (never a path); a valid existing choice for this config is never replaced. */
function writeChoice(directory: string, configIdentity: string, key: string): boolean {
  const file = readChoices(directory)
  if (file.status === "future") return false
  const id = choiceKey(configIdentity)
  if (file.choices[id] !== undefined) return false
  if (Object.keys(file.choices).length >= MAX_CHOICES) return false
  const choices = { ...file.choices, [id]: profileDisplayName(key) }
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
    return true
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Cross-process selection lock: exclusive create, kept alive by heartbeats, stolen only when stale. */
export class SelectionLock {
  private released = false
  private constructor(readonly directory: string, readonly token: string) {}

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
    if (this.released) return
    const time = new Date()
    try { utimesSync(join(this.directory, LOCK_FILENAME), time, time) } catch {}
  }

  release(): void {
    if (this.released) return
    this.released = true
    const path = join(this.directory, LOCK_FILENAME)
    try {
      if (JSON.parse(readFileSync(path, "utf8")).token === this.token) rmSync(path, { force: true })
    } catch {}
  }

  /** Records the user's answer while still holding the lock; false when it could not be remembered. */
  commit(context: TransitionContext, key: string): boolean {
    return writeChoice(this.directory, context.configIdentity, key)
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
  const remembered = rememberedKey(directory, context.configIdentity)
  if (remembered !== undefined) return { kind: "resolved", key: remembered, reason: "remembered" }
  mkdirSync(directory, { recursive: true })
  // Concurrent first launches wait here: only the lock holder detects, asks and records.
  for (;;) {
    const lock = SelectionLock.tryAcquire(directory, dependencies.now)
    if (!lock) {
      dependencies.sleep(LOCK_POLL_MS)
      const decided = rememberedKey(directory, context.configIdentity)
      if (decided !== undefined) return { kind: "resolved", key: decided, reason: "remembered" }
      continue
    }
    try {
      const decided = rememberedKey(directory, context.configIdentity)
      if (decided !== undefined) {
        lock.release()
        return { kind: "resolved", key: decided, reason: "remembered" }
      }
      const candidates = detectCandidates(context)
      if (candidates.length > 1) return { kind: "ask", candidates, lock }
      const key = candidates[0]?.key ?? DEFAULT_PROFILE_KEY
      const stored = writeChoice(directory, context.configIdentity, key)
      lock.release()
      return { kind: "resolved", key, reason: !stored ? "unremembered" : candidates.length ? "single" : "none" }
    } catch (error) {
      lock.release()
      throw error
    }
  }
}
