import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { profileScope } from "./data-profile"
import { SELECTION_TEMP_MAX_AGE_MS, SELECTION_TEMP_PREFIX, sweepSelectionFolders } from "./profile-selection-cleanup"
import {
  choiceKey, hasRestorableState, LOCK_STALE_MS, readChoices, rememberedChoice, rememberedProfileState, rememberNextLaunch, resolveTransitionProfile,
  selectionDirectory, type TransitionContext,
} from "./profile-transition"

const vectors = JSON.parse(readFileSync(new URL("./data-profile-vectors.json", import.meta.url), "utf8"))
const fixture = (name: string) => vectors.stateFixtures.find((entry: { name: string }) => entry.name === name)
const WITH_TABS = JSON.stringify(fixture("partitioned window with a workspace tab").content)
const EMPTY = JSON.stringify(fixture("partitioned window with only the session partition").content)

function sandbox(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codenomad-profile-transition-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const context: TransitionContext = {
    configIdentity: "/home/dev/.config/codenomad/config.yaml",
    defaultIdentity: "/home/dev/.config/codenomad/config.yaml",
    userDataBase: join(root, "CodeNomad"),
    defaultStateFiles: [join(root, "home", ".codenomad", "client-state", "v2", "client-state.json"), join(root, "legacy", "client-state.json")],
  }
  const write = (path: string, content: string, mtime = Date.now()) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    utimesSync(path, mtime / 1000, mtime / 1000)
  }
  const scopedFile = (key: string) => join(context.userDataBase, "scopes", profileScope(key, context.configIdentity, context.defaultIdentity).scopeName, "client-state", "client-state.json")
  const resolve = () => resolveTransitionProfile(context, { now: Date.now })
  return { root, context, write, scopedFile, resolve, directory: selectionDirectory(context.userDataBase) }
}

test("restorable-state fixtures shared with Tauri", (t) => {
  const { root } = sandbox(t)
  for (const entry of vectors.stateFixtures) {
    const path = join(root, `${entry.name.replace(/\W+/g, "-")}.json`)
    writeFileSync(path, entry.raw ?? JSON.stringify(entry.content))
    assert.equal(hasRestorableState(path).restorable, entry.restorable, entry.name)
  }
  assert.equal(hasRestorableState(join(root, "missing.json")).restorable, false)
})

test("no profile with state keeps the default profile and remembers it", (t) => {
  const { context, write, scopedFile, resolve, directory } = sandbox(t)
  write(scopedFile("dev"), EMPTY)
  assert.deepEqual(resolve(), { key: "stable", reason: "none" })
  assert.deepEqual(readChoices(directory), { status: "valid", choices: { [choiceKey(context.configIdentity)]: "default" } })
  assert.match(readFileSync(join(directory, "choices.json"), "utf8"), /"default"/)
  assert.doesNotMatch(readFileSync(join(directory, "choices.json"), "utf8"), /config\.yaml|scopes/)
})

test("exactly one profile with state is selected without asking", (t) => {
  const { write, scopedFile, resolve, context } = sandbox(t)
  write(scopedFile("dev"), WITH_TABS)
  write(context.defaultStateFiles[0]!, EMPTY)
  assert.deepEqual(resolve(), { key: "dev", reason: "single" })
  // Later launches reuse the remembered profile even if other profiles gain state.
  write(context.defaultStateFiles[0]!, WITH_TABS)
  assert.deepEqual(resolve(), { key: "dev", reason: "remembered" })
})

test("legacy default files count only while the current shared file is absent", (t) => {
  const { write, context, resolve } = sandbox(t)
  write(context.defaultStateFiles[1]!, JSON.stringify(fixture("legacy monolithic snapshot with tabs").content))
  assert.deepEqual(resolve(), { key: "stable", reason: "single" })
})

test("several profiles with state open the most recently used one and remember it", (t) => {
  const { write, scopedFile, resolve, context, directory } = sandbox(t)
  write(context.defaultStateFiles[0]!, WITH_TABS, Date.UTC(2026, 8, 1))
  write(scopedFile("dev-v2"), WITH_TABS, Date.UTC(2026, 9, 1))
  write(scopedFile("dev"), WITH_TABS, Date.UTC(2026, 7, 1))
  assert.deepEqual(resolve(), { key: "dev-v2", reason: "most-recent" })
  assert.deepEqual(readChoices(directory), { status: "valid", choices: { [choiceKey(context.configIdentity)]: "dev-v2" } })
  // Later launches reuse it even when another profile becomes more recent.
  write(context.defaultStateFiles[0]!, WITH_TABS, Date.UTC(2026, 10, 1))
  assert.deepEqual(resolve(), { key: "dev-v2", reason: "remembered" })
})

test("profiles last used at the same time prefer the default profile, then dev", (t) => {
  const time = Date.UTC(2026, 8, 1)
  const all = sandbox(t)
  for (const key of ["dev-v2", "dev"]) all.write(all.scopedFile(key), WITH_TABS, time)
  all.write(all.context.defaultStateFiles[0]!, WITH_TABS, time)
  assert.deepEqual(all.resolve(), { key: "stable", reason: "most-recent" })
  const scoped = sandbox(t)
  for (const key of ["dev-v2", "dev"]) scoped.write(scoped.scopedFile(key), WITH_TABS, time)
  assert.deepEqual(scoped.resolve(), { key: "dev", reason: "most-recent" })
})

test("while another process holds the selection lock the detected profile starts unremembered", (t) => {
  const { write, scopedFile, resolve, context, directory } = sandbox(t)
  write(context.defaultStateFiles[0]!, WITH_TABS, Date.UTC(2026, 8, 1))
  write(scopedFile("dev-v2"), WITH_TABS, Date.UTC(2026, 9, 1))
  const held = JSON.stringify({ pid: 1, token: "launch" })
  write(join(directory, "choices.lock"), held)
  assert.deepEqual(resolve(), { key: "dev-v2", reason: "unremembered" })
  assert.equal(existsSync(join(directory, "choices.json")), false)
  assert.equal(readFileSync(join(directory, "choices.lock"), "utf8"), held)
  // Once the holder has remembered a profile, launches use it.
  write(join(directory, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey(context.configIdentity)]: "default" } }))
  assert.deepEqual(resolve(), { key: "stable", reason: "remembered" })
})

test("a valid remembered choice is never overridden; corrupt choices rerun detection", (t) => {
  const { write, scopedFile, resolve, context, directory } = sandbox(t)
  write(join(directory, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey(context.configIdentity)]: "dev" } }))
  write(context.defaultStateFiles[0]!, WITH_TABS)
  mkdirSync(dirname(dirname(scopedFile("dev"))), { recursive: true })
  assert.deepEqual(resolve(), { key: "dev", reason: "remembered" })
  write(join(directory, "choices.json"), "{ not json")
  write(scopedFile("dev"), EMPTY)
  assert.deepEqual(resolve(), { key: "stable", reason: "single" })
  write(join(directory, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey(context.configIdentity)]: "../escape" } }))
  assert.deepEqual(resolve(), { key: "stable", reason: "single" })
})

test("a remembered named profile that no longer exists for this config reruns detection and is replaced", (t) => {
  const { write, scopedFile, resolve, context, directory } = sandbox(t)
  const other = choiceKey("/other/config.yaml")
  write(join(directory, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey(context.configIdentity)]: "dev", [other]: "dev" } }))
  // `dev` exists only for another configuration: this one's folder was deleted.
  mkdirSync(join(context.userDataBase, "scopes", profileScope("dev", "/other/config.yaml", context.defaultIdentity).scopeName), { recursive: true })
  write(context.defaultStateFiles[0]!, WITH_TABS)
  assert.deepEqual(resolve(), { key: "stable", reason: "single" })
  assert.deepEqual(readChoices(directory), { status: "valid", choices: { [choiceKey(context.configIdentity)]: "default", [other]: "dev" } })
  // A remembered profile whose folder exists is kept; `default` never needs a folder.
  write(scopedFile("dev"), EMPTY)
  write(join(directory, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey(context.configIdentity)]: "dev" } }))
  assert.deepEqual(resolve(), { key: "dev", reason: "remembered" })
})

test("an explicit next-launch choice replaces the remembered one and the next launch opens it", (t) => {
  const { write, scopedFile, resolve, context, directory } = sandbox(t)
  write(scopedFile("dev"), WITH_TABS)
  assert.deepEqual(resolve(), { key: "dev", reason: "single" })
  // A profile without folders yet: its folder is created so the remembered-profile check keeps it.
  assert.equal(rememberNextLaunch(context, "team"), "updated")
  assert.equal(rememberedChoice(directory, context.configIdentity), "team")
  assert.equal(rememberedProfileState("team", context), "present")
  assert.deepEqual(resolve(), { key: "team", reason: "remembered" })
  assert.equal(rememberNextLaunch(context, "stable"), "updated")
  assert.equal(rememberedChoice(directory, context.configIdentity), "default")
  assert.deepEqual(resolve(), { key: "stable", reason: "remembered" })
  assert.equal(rememberedChoice(directory, "/other/config.yaml"), null)
})

test("a linked scope is followed; while its target is unavailable the choice is kept and this launch is unremembered", (t) => {
  const { write, scopedFile, resolve, context, directory, root } = sandbox(t)
  const relocated = join(root, "other-disk", "dev")
  mkdirSync(relocated, { recursive: true })
  const scopeFolder = dirname(dirname(scopedFile("dev")))
  mkdirSync(dirname(scopeFolder), { recursive: true })
  symlinkSync(relocated, scopeFolder, "junction")
  const remembered = { version: 1, choices: { [choiceKey(context.configIdentity)]: "dev" } }
  write(join(directory, "choices.json"), JSON.stringify(remembered))
  write(context.defaultStateFiles[0]!, WITH_TABS)
  assert.deepEqual(resolve(), { key: "dev", reason: "remembered" })
  // The drive holding the target is disconnected: detection decides this launch only.
  rmSync(relocated, { recursive: true })
  assert.deepEqual(resolve(), { key: "stable", reason: "unremembered" })
  assert.deepEqual(readChoices(directory), { status: "valid", choices: remembered.choices })
  // The target returns: the remembered profile is used again.
  mkdirSync(relocated, { recursive: true })
  assert.deepEqual(resolve(), { key: "dev", reason: "remembered" })
})

test("remembered profile states follow the shared vectors", () => {
  const context = { configIdentity: "/c/config.yaml", defaultIdentity: "/c/config.yaml", userDataBase: "/base" }
  const entry = (value: string) => {
    if (/^E[A-Z]+$/.test(value)) throw Object.assign(new Error(value), { code: value })
    return { isSymbolicLink: () => value === "link", isDirectory: () => value === "dir" }
  }
  for (const vector of vectors.rememberedProfileStates as Array<{ lstat: string; stat: string | null; state: string }>) {
    const probe = {
      lstat: () => entry(vector.lstat),
      stat: () => vector.stat === null ? assert.fail("stat must not run") : entry(vector.stat),
    }
    assert.equal(rememberedProfileState("dev", context, probe), vector.state, JSON.stringify(vector))
  }
  const absent = { lstat: () => entry("ENOENT"), stat: () => entry("ENOENT") }
  assert.equal(rememberedProfileState("stable", context, absent), "present", "the default profile always exists")
})

test("full choices files follow the shared capacity vectors", (t) => {
  for (const vector of vectors.choicesCapacity as Array<{ name: string; otherEntries: number; current: string | null; reason: string; stored: string | null }>) {
    const { write, resolve, context, directory } = sandbox(t)
    const choices: Record<string, string> = {}
    for (let index = 0; index < vector.otherEntries; index += 1) choices[choiceKey(`/other/${index}/config.yaml`)] = "dev"
    if (vector.current) choices[choiceKey(context.configIdentity)] = vector.current
    write(join(directory, "choices.json"), JSON.stringify({ version: 1, choices }))
    assert.deepEqual(resolve(), { key: "stable", reason: vector.reason }, vector.name)
    const stored = readChoices(directory) as { choices: Record<string, string> }
    assert.equal(stored.choices[choiceKey(context.configIdentity)] ?? null, vector.stored, vector.name)
  }
})

test("an unknown future choices file is never overwritten", (t) => {
  const { write, resolve, directory } = sandbox(t)
  const future = JSON.stringify({ version: 2, profiles: {} })
  write(join(directory, "choices.json"), future)
  assert.deepEqual(resolve(), { key: "stable", reason: "unremembered" })
  assert.equal(readFileSync(join(directory, "choices.json"), "utf8"), future)
})

test("choices are keyed by config identity", (t) => {
  const { write, resolve, directory } = sandbox(t)
  write(join(directory, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey("/other/config.yaml")]: "dev" } }))
  assert.deepEqual(resolve(), { key: "stable", reason: "none" })
  assert.deepEqual(Object.values((readChoices(directory) as { choices: Record<string, string> }).choices).sort(), ["default", "dev"])
})

test("an unwritable choices file never prevents startup: the detected profile is used unremembered", (t) => {
  const { write, scopedFile, resolve, context, directory } = sandbox(t)
  write(scopedFile("dev"), WITH_TABS)
  // A directory in place of choices.json makes the atomic rename fail like EPERM/EBUSY would.
  mkdirSync(join(directory, "choices.json"), { recursive: true })
  assert.deepEqual(resolve(), { key: "dev", reason: "unremembered" })
  write(context.defaultStateFiles[0]!, WITH_TABS, Date.now() + 60_000)
  assert.deepEqual(resolve(), { key: "stable", reason: "unremembered" })
  assert.equal(readdirSync(directory).filter((entry) => entry.endsWith(".tmp")).length, 0)
  assert.equal(readdirSync(directory).includes("choices.lock"), false)
})

test("an unusable selection directory or lock still starts with the detected profile", (t) => {
  const { write, scopedFile, resolve, context, directory } = sandbox(t)
  write(scopedFile("dev-v2"), WITH_TABS)
  // A file where the selection directory should be: mkdir and the lock both fail without EEXIST contention.
  write(directory, "not a directory")
  assert.deepEqual(resolve(), { key: "dev-v2", reason: "unremembered" })
  write(context.defaultStateFiles[0]!, WITH_TABS, Date.now() + 60_000)
  assert.deepEqual(resolve(), { key: "stable", reason: "unremembered" })
  assert.equal(readFileSync(directory, "utf8"), "not a directory")
})

test("choice keys fold Unicode case on Windows so both hosts share a choice", () => {
  for (const vector of vectors.choiceKeys) {
    const keys = vector.identities.map((identity: string) => choiceKey(identity, vector.windows ? "win32" : "linux"))
    if (vector.key) for (const key of keys) assert.equal(key, vector.key)
    else assert.notEqual(keys[0], keys[1])
  }
})

test("question folders left by older builds are swept once stale, and nothing else", (t) => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-selection-sweep-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const folder = (name: string, age = 0) => {
    const path = join(root, name)
    mkdirSync(join(path, "Network"), { recursive: true })
    writeFileSync(join(path, "Local State"), "{}")
    const time = (Date.now() - age) / 1000
    utimesSync(path, time, time)
    return path
  }
  folder(`${SELECTION_TEMP_PREFIX}fresh`)
  const stale = folder(`${SELECTION_TEMP_PREFIX}stale`, SELECTION_TEMP_MAX_AGE_MS + 60_000)
  folder("other-stale", SELECTION_TEMP_MAX_AGE_MS + 60_000)
  const target = folder("link-target")
  symlinkSync(target, join(root, `${SELECTION_TEMP_PREFIX}linked`), "junction")
  assert.deepEqual(sweepSelectionFolders({ temporaryRoot: root }), [stale])
  assert.deepEqual(readdirSync(root).sort(), [`${SELECTION_TEMP_PREFIX}fresh`, `${SELECTION_TEMP_PREFIX}linked`, "link-target", "other-stale"])
  // However old, a link is neither removed nor followed.
  const later = Date.now() + 2 * SELECTION_TEMP_MAX_AGE_MS
  assert.deepEqual(sweepSelectionFolders({ temporaryRoot: root, now: later }), [join(root, `${SELECTION_TEMP_PREFIX}fresh`)])
  assert.ok(lstatSync(join(root, `${SELECTION_TEMP_PREFIX}linked`)).isSymbolicLink())
  assert.ok(existsSync(join(target, "Local State")))
})

test("a stale lock from a crashed launch is taken over", (t) => {
  const { write, resolve, directory } = sandbox(t)
  const stale = Date.now() - LOCK_STALE_MS - 5_000
  write(join(directory, "choices.lock"), JSON.stringify({ pid: 1, token: "crashed" }), stale)
  assert.deepEqual(resolve(), { key: "stable", reason: "none" })
  assert.equal(existsSync(join(directory, "choices.lock")), false)
})
