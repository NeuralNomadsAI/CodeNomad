import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { profileScope } from "./data-profile"
import { selectedProfileKey, selectionDialogContent } from "./profile-selection-dialog"
import { choiceKey, hasRestorableState, LOCK_STALE_MS, readChoices, resolveTransitionProfile, selectionDirectory, type TransitionContext } from "./profile-transition"

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
  const resolve = (sleep: (ms: number) => void = () => assert.fail("unexpected wait")) => resolveTransitionProfile(context, { now: Date.now, sleep })
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
  assert.deepEqual(resolve(), { kind: "resolved", key: "stable", reason: "none" })
  assert.deepEqual(readChoices(directory), { status: "valid", choices: { [choiceKey(context.configIdentity)]: "default" } })
  assert.match(readFileSync(join(directory, "choices.json"), "utf8"), /"default"/)
  assert.doesNotMatch(readFileSync(join(directory, "choices.json"), "utf8"), /config\.yaml|scopes/)
})

test("exactly one profile with state is selected without asking", (t) => {
  const { write, scopedFile, resolve, context } = sandbox(t)
  write(scopedFile("dev"), WITH_TABS)
  write(context.defaultStateFiles[0]!, EMPTY)
  assert.deepEqual(resolve(), { kind: "resolved", key: "dev", reason: "single" })
  // Later launches reuse the remembered profile even if other profiles gain state.
  write(context.defaultStateFiles[0]!, WITH_TABS)
  assert.deepEqual(resolve(), { kind: "resolved", key: "dev", reason: "remembered" })
})

test("legacy default files count only while the current shared file is absent", (t) => {
  const { write, context, resolve } = sandbox(t)
  write(context.defaultStateFiles[1]!, JSON.stringify(fixture("legacy monolithic snapshot with tabs").content))
  assert.deepEqual(resolve(), { kind: "resolved", key: "stable", reason: "single" })
})

test("several profiles with state ask once, most recent first, and remember the answer", (t) => {
  const { write, scopedFile, resolve, context, directory } = sandbox(t)
  write(context.defaultStateFiles[0]!, WITH_TABS, Date.UTC(2026, 8, 1))
  write(scopedFile("dev-v2"), WITH_TABS, Date.UTC(2026, 9, 1))
  const asked = resolve()
  assert.equal(asked.kind, "ask")
  if (asked.kind !== "ask") return
  assert.deepEqual(asked.candidates.map((candidate) => candidate.name), ["dev-v2", "default"])
  const content = selectionDialogContent(asked.candidates)
  assert.deepEqual(content.buttons, ["Use dev-v2", "Use default", "Quit"])
  assert.match(content.detail, /dev-v2: last used 2026-10-01/)
  assert.equal(selectedProfileKey(asked.candidates, 2), undefined)
  assert.equal(selectedProfileKey(asked.candidates, 1), "stable")
  // While the question is open another first launch waits instead of asking or diverging.
  let waits = 0
  const waiting = resolve(() => {
    if (waits++ === 0) {
      asked.lock.commit(context, "dev-v2")
      asked.lock.release()
    }
  })
  assert.deepEqual(waiting, { kind: "resolved", key: "dev-v2", reason: "remembered" })
  assert.deepEqual(resolve(), { kind: "resolved", key: "dev-v2", reason: "remembered" })
  assert.equal(readChoices(directory).status, "valid")
})

test("a valid remembered choice is never overridden; corrupt choices rerun detection", (t) => {
  const { write, scopedFile, resolve, context, directory } = sandbox(t)
  write(join(directory, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey(context.configIdentity)]: "dev" } }))
  write(context.defaultStateFiles[0]!, WITH_TABS)
  assert.deepEqual(resolve(), { kind: "resolved", key: "dev", reason: "remembered" })
  write(join(directory, "choices.json"), "{ not json")
  write(scopedFile("dev"), EMPTY)
  assert.deepEqual(resolve(), { kind: "resolved", key: "stable", reason: "single" })
  write(join(directory, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey(context.configIdentity)]: "../escape" } }))
  assert.deepEqual(resolve(), { kind: "resolved", key: "stable", reason: "single" })
})

test("an unknown future choices file is never overwritten", (t) => {
  const { write, resolve, directory } = sandbox(t)
  const future = JSON.stringify({ version: 2, profiles: {} })
  write(join(directory, "choices.json"), future)
  assert.deepEqual(resolve(), { kind: "resolved", key: "stable", reason: "unremembered" })
  assert.equal(readFileSync(join(directory, "choices.json"), "utf8"), future)
})

test("choices are keyed by config identity", (t) => {
  const { write, resolve, directory } = sandbox(t)
  write(join(directory, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey("/other/config.yaml")]: "dev" } }))
  assert.deepEqual(resolve(), { kind: "resolved", key: "stable", reason: "none" })
  assert.deepEqual(Object.values((readChoices(directory) as { choices: Record<string, string> }).choices).sort(), ["default", "dev"])
})

test("a stale lock from a crashed launch is taken over", (t) => {
  const { write, resolve, directory } = sandbox(t)
  const stale = Date.now() - LOCK_STALE_MS - 5_000
  write(join(directory, "choices.lock"), JSON.stringify({ pid: 1, token: "crashed" }), stale)
  let waits = 0
  assert.deepEqual(resolve(() => { waits++ }), { kind: "resolved", key: "stable", reason: "none" })
  assert.equal(waits, 1)
})
