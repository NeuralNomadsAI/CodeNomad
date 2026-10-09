import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { deleteOtherProfiles, listOtherProfiles, requireProfileIds, resolveProfileRoots, TAURI_IDENTIFIER, type CleanupDependencies, type CurrentProfile, type ProfileRoots } from "./data-profile-cleanup"
import { profileScope } from "./data-profile"
import { choiceKey } from "./profile-transition"

const CONFIG = "/home/user/.config/codenomad/config.yaml"
const OTHER_CONFIG = "/work/other/config.yaml"
const LIVE = 4242

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "codenomad-profile-cleanup-"))
  const roots: ProfileRoots = {
    electronBase: join(base, "Roaming", "CodeNomad"),
    webviewRoot: join(base, "Local", `${TAURI_IDENTIFIER}-v2`),
    tauriDataParent: join(base, "Roaming"),
    homeClientState: join(base, "home", ".codenomad", "client-state"),
  }
  const file = (path: string, bytes = 10) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "x".repeat(bytes)) }
  const scope = (key: string, config = CONFIG) => profileScope(key, config, CONFIG)
  const tauriLock = (key: string, config = CONFIG) => join(roots.tauriDataParent, `${TAURI_IDENTIFIER}.scope.s${scope(key, config).suffix}`)
  return { base, roots, file, scope, tauriLock, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

const current = (key: string, configIdentity = CONFIG): CurrentProfile => ({ key, configIdentity, defaultIdentity: CONFIG })
const dependencies = (overrides: Partial<CleanupDependencies> = {}): CleanupDependencies =>
  ({ pidAlive: (pid) => pid === LIVE, now: () => Date.now(), ...overrides })

/** Builds: the open `dev` profile, the default profile, `dev-v2` on both hosts, `team` of another config and an orphan lock folder. */
function populated() {
  const context = fixture()
  const { roots, file, scope, tauriLock } = context
  file(join(roots.electronBase, "scopes", scope("dev").scopeName, "client-state", "client-state.json"), 5)
  file(join(roots.webviewRoot, "scopes", scope("dev").scopeName, "EBWebView", "data"), 5)
  file(join(tauriLock("dev"), "client-state.primary.lock"), 0)
  file(join(roots.electronBase, "scopes", scope("dev-v2").scopeName, "client-state", "client-state.json"), 100)
  file(join(roots.webviewRoot, "scopes", scope("dev-v2").scopeName, "EBWebView", "Default", "data"), 200)
  file(join(tauriLock("dev-v2"), "client-state.registration.owner"), 3)
  file(join(roots.electronBase, "scopes", scope("team", OTHER_CONFIG).scopeName, "developer-mode-browser-v2", "Local State"), 50)
  file(join(roots.tauriDataParent, `${TAURI_IDENTIFIER}.scope.s${"f".repeat(16)}`, "client-state.primary.lock"), 1)
  file(join(roots.electronBase, "developer-mode-browser-v2", "Local State"), 1000)
  file(join(roots.electronBase, "client-state.json"), 20)
  file(join(roots.homeClientState, "v2", "client-state.json"), 30)
  file(join(roots.homeClientState, "v2", "partitions", "a".repeat(64)), 40)
  file(join(roots.homeClientState, "v2", "election", "participant.1.a.json"), 2)
  // A participant left by a process that has exited does not hold the profile.
  writeFileSync(join(roots.homeClientState, "v2", "election", "participant.1.a.json"), JSON.stringify({ pid: 1, runToken: "a", processStartIdentity: "old" }))
  file(join(roots.webviewRoot, "developer-mode", "local", "EBWebView", "Default", "data"), 400)
  file(join(roots.tauriDataParent, TAURI_IDENTIFIER, "client-state.json"), 60)
  file(join(roots.electronBase, "profile-selection", "choices.json"), 0)
  file(join(roots.electronBase, "Local Storage", "leveldb"), 7)
  return context
}

test("lists every other profile across configs, the default profile and orphan lock folders, never the open one", async () => {
  const context = populated()
  try {
    const { profiles } = await listOtherProfiles(context.roots, current("dev"), dependencies())
    const byId = new Map(profiles.map((profile) => [profile.id, profile]))
    assert.deepEqual([...byId.keys()], [
      "default",
      `scope:${context.scope("dev-v2").scopeName}`,
      `scope:${context.scope("team", OTHER_CONFIG).scopeName}`,
      `orphan:${"f".repeat(16)}`,
    ])
    assert.equal(byId.get("default")!.sizeBytes, 1000 + 20 + 30 + 40 + 400 + 60)
    assert.equal(byId.get("default")!.otherConfiguration, false)
    const devV2 = byId.get(`scope:${context.scope("dev-v2").scopeName}`)!
    assert.deepEqual([devV2.name, devV2.kind, devV2.sizeBytes, devV2.sizeComplete, devV2.status, devV2.otherConfiguration], ["dev-v2", "scope", 303, true, "available", false])
    assert.equal(byId.get(`scope:${context.scope("team", OTHER_CONFIG).scopeName}`)!.otherConfiguration, true)
    assert.equal(byId.get(`orphan:${"f".repeat(16)}`)!.sizeBytes, 1)
  } finally {
    context.cleanup()
  }
})

test("the default profile is listed only when a named profile is open, and an empty machine lists nothing", async () => {
  const context = populated()
  const empty = fixture()
  try {
    const { profiles } = await listOtherProfiles(context.roots, current("stable"), dependencies())
    assert.ok(!profiles.some((profile) => profile.kind === "default"))
    assert.ok(profiles.some((profile) => profile.id === `scope:${context.scope("dev").scopeName}`))
    assert.deepEqual((await listOtherProfiles(empty.roots, current("stable"), dependencies())).profiles, [])
    // The default profile of another configuration is scoped and therefore listed by its scope.
    const otherDefault = await listOtherProfiles(context.roots, current("dev", OTHER_CONFIG), dependencies())
    assert.equal(otherDefault.profiles.find((profile) => profile.kind === "default")?.otherConfiguration, true)
  } finally {
    context.cleanup()
    empty.cleanup()
  }
})

test("lock folders are found among many unrelated application folders", async () => {
  const context = populated()
  try {
    // NTFS lists names alphabetically: these precede `ai.neuralnomads...` in %APPDATA%.
    for (let index = 0; index < 600; index += 1) mkdirSync(join(context.roots.tauriDataParent, `aa-app-${index}`))
    const { profiles } = await listOtherProfiles(context.roots, current("dev"), dependencies())
    assert.ok(profiles.some((profile) => profile.id === `orphan:${"f".repeat(16)}`))
  } finally {
    context.cleanup()
  }
})

test("size measurement is bounded and reports a lower bound", async () => {
  const context = fixture()
  try {
    for (let index = 0; index < 20; index += 1) context.file(join(context.roots.electronBase, "scopes", context.scope("big").scopeName, `f${index}`), 1)
    const { profiles } = await listOtherProfiles(context.roots, current("stable"), dependencies({ sizeEntries: 5 }))
    assert.equal(profiles[0]!.sizeComplete, false)
    assert.ok(profiles[0]!.sizeBytes < 20)
  } finally {
    context.cleanup()
  }
})

test("profiles open in Electron or Tauri, or in an unknown state, are reported and never deleted", async () => {
  const cases: Array<[string, (context: ReturnType<typeof fixture>, scopeName: string) => void, string]> = [
    ["electron marker", (c, s) => c.file(join(c.roots.electronBase, "scopes", s, `client-state.running.${LIVE}.token.json`)), "in-use"],
    ["electron primary lock", (c, s) => writeFileSync(join(c.roots.electronBase, "scopes", s, "client-state.primary.lock"), JSON.stringify({ pid: LIVE, runToken: "t" })), "in-use"],
    ["chromium singleton", (c, s) => c.file(join(c.roots.electronBase, "scopes", s, "developer-mode-browser-v2", "lockfile")), "in-use"],
    ["cross-host election", (c, s) => {
      const participant = join(c.roots.electronBase, "scopes", s, "client-state", "election", `participant.${LIVE}.t.json`)
      c.file(participant)
      writeFileSync(participant, JSON.stringify({ pid: LIVE, runToken: "t", processStartIdentity: "x" }))
    }, "in-use"],
    ["tauri marker", (c) => c.file(join(c.tauriLock("dev-v2"), `client-state.running.${LIVE}.0.lock`)), "in-use"],
    ["webview2 lock", (c, s) => c.file(join(c.roots.webviewRoot, "scopes", s, "developer-mode", "local", "EBWebView", "lockfile")), "in-use"],
    ["unparseable lock", (c, s) => writeFileSync(join(c.roots.electronBase, "scopes", s, "client-state.primary.lock"), "{"), "unknown"],
  ]
  for (const [label, arrange, expected] of cases) {
    const context = populated()
    try {
      const scopeName = context.scope("dev-v2").scopeName
      arrange(context, scopeName)
      const id = `scope:${scopeName}`
      const listed = (await listOtherProfiles(context.roots, current("dev"), dependencies())).profiles.find((profile) => profile.id === id)
      assert.equal(listed?.status, expected, label)
      const { results } = await deleteOtherProfiles(context.roots, current("dev"), [id], dependencies())
      assert.equal(results[0]!.outcome, expected, label)
      assert.ok(existsSync(join(context.roots.electronBase, "scopes", scopeName)), label)
      assert.ok(existsSync(context.tauriLock("dev-v2")), label)
    } finally {
      context.cleanup()
    }
  }
})

test("a dead owner does not block deletion and a profile opened mid-deletion stops it", async () => {
  const context = populated()
  try {
    const scopeName = context.scope("dev-v2").scopeName
    context.file(join(context.tauriLock("dev-v2"), "client-state.running.9999.0.lock"))
    let removals = 0
    const result = await deleteOtherProfiles(context.roots, current("dev"), [`scope:${scopeName}`], dependencies({
      // The first removal succeeds, then another host opens the profile.
      pidAlive: (pid) => pid === 9999 && removals > 0,
      remove: async (path, directory) => { removals += 1; rmSync(path, { recursive: directory, force: true }) },
    }))
    assert.equal(removals, 1)
    assert.equal(result.results[0]!.outcome, "incomplete")
    assert.deepEqual(result.results[0]!.remaining, [join(context.roots.webviewRoot, "scopes", scopeName), context.tauriLock("dev-v2")])
  } finally {
    context.cleanup()
  }
})

test("deleting a named profile removes its folders on both hosts and nothing else", async () => {
  const context = populated()
  try {
    const scopeName = context.scope("dev-v2").scopeName
    const result = await deleteOtherProfiles(context.roots, current("dev"), [`scope:${scopeName}`, `orphan:${"f".repeat(16)}`], dependencies())
    assert.deepEqual(result.results.map((entry) => entry.outcome), ["deleted", "deleted"])
    assert.ok(!existsSync(join(context.roots.electronBase, "scopes", scopeName)))
    assert.ok(!existsSync(join(context.roots.webviewRoot, "scopes", scopeName)))
    assert.ok(!existsSync(context.tauriLock("dev-v2")))
    assert.ok(existsSync(join(context.roots.electronBase, "scopes", context.scope("dev").scopeName)))
    assert.ok(existsSync(context.tauriLock("dev")))
    assert.ok(existsSync(join(context.roots.electronBase, "developer-mode-browser-v2")))
  } finally {
    context.cleanup()
  }
})

test("deleting the default profile removes only its own children and reports unrecognized entries", async () => {
  const context = populated()
  try {
    const result = await deleteOtherProfiles(context.roots, current("dev"), ["default"], dependencies())
    const [entry] = result.results
    assert.equal(entry!.outcome, "deleted")
    for (const removed of [
      join(context.roots.electronBase, "developer-mode-browser-v2"), join(context.roots.electronBase, "client-state.json"),
      join(context.roots.homeClientState, "v2", "client-state.json"), join(context.roots.homeClientState, "v2", "partitions"),
      join(context.roots.webviewRoot, "developer-mode"), join(context.roots.tauriDataParent, TAURI_IDENTIFIER, "client-state.json"),
    ]) assert.ok(!existsSync(removed), removed)
    for (const kept of [
      join(context.roots.electronBase, "scopes", context.scope("dev").scopeName), join(context.roots.electronBase, "scopes", context.scope("dev-v2").scopeName),
      join(context.roots.electronBase, "profile-selection", "choices.json"), join(context.roots.webviewRoot, "scopes", context.scope("dev-v2").scopeName),
      join(context.roots.homeClientState, "v2", "election"), join(context.roots.electronBase, "Local Storage"),
    ]) assert.ok(existsSync(kept), kept)
    assert.deepEqual(entry!.kept, [join(context.roots.electronBase, "Local Storage")])
  } finally {
    context.cleanup()
  }
})

test("links and junctions are never listed or followed", async () => {
  const context = populated()
  const outside = mkdtempSync(join(tmpdir(), "codenomad-profile-outside-"))
  try {
    writeFileSync(join(outside, "precious"), "keep")
    const linked = `linked-${"a".repeat(16)}`
    symlinkSync(outside, join(context.roots.electronBase, "scopes", linked), "junction")
    rmSync(join(context.roots.webviewRoot, "developer-mode"), { recursive: true })
    symlinkSync(outside, join(context.roots.webviewRoot, "local"), "junction")
    const { profiles } = await listOtherProfiles(context.roots, current("dev"), dependencies())
    assert.ok(!profiles.some((profile) => profile.id === `scope:${linked}`))
    assert.equal((await deleteOtherProfiles(context.roots, current("dev"), [`scope:${linked}`], dependencies())).results[0]!.outcome, "missing")
    const result = await deleteOtherProfiles(context.roots, current("dev"), ["default"], dependencies())
    assert.equal(result.results[0]!.outcome, "incomplete")
    assert.deepEqual(result.results[0]!.remaining, [join(context.roots.webviewRoot, "local")])
    assert.equal(readFileSync(join(outside, "precious"), "utf8"), "keep")
  } finally {
    context.cleanup()
    rmSync(outside, { recursive: true, force: true })
  }
})

test("a failed removal reports exactly what remained", async () => {
  const context = populated()
  try {
    const scopeName = context.scope("dev-v2").scopeName
    const stuck = join(context.roots.webviewRoot, "scopes", scopeName)
    const result = await deleteOtherProfiles(context.roots, current("dev"), [`scope:${scopeName}`], dependencies({
      remove: async (path, directory) => {
        if (path === stuck) throw Object.assign(new Error("busy"), { code: "EBUSY" })
        rmSync(path, { recursive: directory, force: true })
      },
    }))
    assert.equal(result.results[0]!.outcome, "incomplete")
    assert.deepEqual(result.results[0]!.remaining, [stuck])
  } finally {
    context.cleanup()
  }
})

test("remembered choices naming a deleted profile are forgotten only when no folder of it remains", async () => {
  const context = populated()
  try {
    const selection = join(context.roots.electronBase, "profile-selection")
    const choices = { [choiceKey("/a")]: "dev-v2", [choiceKey("/b")]: "default", [choiceKey("/c")]: "team", [choiceKey("/d")]: "dev" }
    writeFileSync(join(selection, "choices.json"), JSON.stringify({ version: 1, choices }))
    context.file(join(context.roots.webviewRoot, "scopes", context.scope("team", CONFIG).scopeName, "data"), 1)
    const result = await deleteOtherProfiles(context.roots, current("dev"), [
      `scope:${context.scope("dev-v2").scopeName}`, `scope:${context.scope("team", OTHER_CONFIG).scopeName}`,
    ], dependencies())
    assert.equal(result.choices, "updated")
    const stored = JSON.parse(readFileSync(join(selection, "choices.json"), "utf8"))
    assert.deepEqual(stored, { version: 1, choices: { [choiceKey("/b")]: "default", [choiceKey("/c")]: "team", [choiceKey("/d")]: "dev" } })

    // A launch currently choosing a profile holds the lock: the file is left alone.
    writeFileSync(join(selection, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey("/a")]: "team" } }))
    writeFileSync(join(selection, "choices.lock"), JSON.stringify({ pid: 1, token: "other" }))
    rmSync(join(context.roots.webviewRoot, "scopes", context.scope("team", CONFIG).scopeName), { recursive: true })
    const busy = await deleteOtherProfiles(context.roots, current("dev"), ["default"], dependencies())
    assert.equal(busy.choices, "unchanged")
    context.file(join(context.roots.electronBase, "scopes", context.scope("team").scopeName, "x"), 1)
    const blocked = await deleteOtherProfiles(context.roots, current("dev"), [`scope:${context.scope("team").scopeName}`], dependencies())
    assert.equal(blocked.choices, "busy")
    assert.match(readFileSync(join(selection, "choices.json"), "utf8"), /team/)
  } finally {
    context.cleanup()
  }
})

test("only listing identifiers are accepted from the renderer", () => {
  assert.deepEqual(requireProfileIds(["default", "default", `scope:dev-${"a".repeat(16)}`, `orphan:${"b".repeat(16)}`]), ["default", `scope:dev-${"a".repeat(16)}`, `orphan:${"b".repeat(16)}`])
  for (const invalid of [[], ["../x"], [`scope:../dev-${"a".repeat(16)}`], [`scope:C:\\x-${"a".repeat(16)}`], "default", [1]]) {
    assert.throws(() => requireProfileIds(invalid))
  }
})

test("profile roots follow each host's folder conventions", () => {
  const windows = resolveProfileRoots("C:\\Users\\a\\AppData\\Roaming\\CodeNomad", { USERPROFILE: "C:\\Users\\a", APPDATA: "D:\\Roaming", LOCALAPPDATA: "D:\\Local" }, "win32", "C:\\fallback")
  assert.deepEqual(windows, {
    electronBase: "C:\\Users\\a\\AppData\\Roaming\\CodeNomad",
    webviewRoot: `D:\\Local\\${TAURI_IDENTIFIER}-v2`,
    tauriDataParent: "D:\\Roaming",
    homeClientState: "C:\\Users\\a\\.codenomad\\client-state",
  })
  const linux = resolveProfileRoots("/home/a/.config/CodeNomad", { HOME: "/home/a" }, "linux", "/fallback")
  assert.equal(linux.webviewRoot, `/home/a/.local/share/${TAURI_IDENTIFIER}-v2`)
  assert.equal(linux.tauriDataParent, "/home/a/.local/share")
  const mac = resolveProfileRoots("/Users/a/Library/Application Support/CodeNomad", { HOME: "/Users/a" }, "darwin", "/fallback")
  assert.equal(mac.tauriDataParent, "/Users/a/Library/Application Support")
})
