import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import {
  deleteOtherProfiles, listOtherProfiles, reliableBirthTime, requireProfileIds, resolveProfileRoots, setNextLaunchProfile, TAURI_IDENTIFIER,
  type CleanupDependencies, type CurrentProfile, type ProfileRoots,
} from "./data-profile-cleanup"
import { profileScope } from "./data-profile"
import { choiceKey, LOCK_STALE_MS } from "./profile-transition"

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

const current = (key: string, configIdentity = CONFIG): CurrentProfile => ({ key, configIdentity, defaultIdentity: CONFIG, pinned: false })
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
    // The open profile is measured with the same bound.
    const open = (await listOtherProfiles(context.roots, current("big"), dependencies({ sizeEntries: 5 }))).current
    assert.equal(open.sizeComplete, false)
    assert.ok(open.sizeBytes < 20)
  } finally {
    context.cleanup()
  }
})

const at = (path: string, time: number) => utimesSync(path, time / 1000, time / 1000)
/** Birth times exist on Windows and macOS; Linux reports them only where the filesystem keeps them. */
const createdBetween = (value: number | null, from: number, to: number) =>
  value === null ? process.platform === "linux" : value >= from && value <= to

test("profiles carry their main folder's creation date and their client state's last use", async () => {
  const from = Date.now() - 2_000
  const context = populated()
  const to = Date.now() + 2_000
  try {
    const { roots, scope, file } = context
    const used = Date.UTC(2026, 8, 1)
    at(join(roots.electronBase, "scopes", scope("dev-v2").scopeName, "client-state", "client-state.json"), used)
    // The default profile counts the shared file, restorable or not, and its legacy files only without it.
    at(join(roots.homeClientState, "v2", "client-state.json"), used + 1_000)
    at(join(roots.electronBase, "client-state.json"), used + 5_000)
    // Only Tauri's WebView storage exists for `solo`: no client-state folder or file.
    file(join(roots.webviewRoot, "scopes", scope("solo").scopeName, "EBWebView", "data"), 1)
    const list = async () => new Map((await listOtherProfiles(roots, current("dev"), dependencies())).profiles.map((profile) => [profile.id, profile]))
    const byId = await list()
    const devV2 = byId.get(`scope:${scope("dev-v2").scopeName}`)!
    assert.equal(devV2.lastUsedAt, used)
    assert.ok(createdBetween(devV2.createdAt, from, to), String(devV2.createdAt))
    const defaultProfile = byId.get("default")!
    assert.equal(defaultProfile.name, "default")
    assert.equal(defaultProfile.lastUsedAt, used + 1_000)
    assert.ok(createdBetween(defaultProfile.createdAt, from, to), String(defaultProfile.createdAt))
    const team = byId.get(`scope:${scope("team", OTHER_CONFIG).scopeName}`)!
    assert.equal(team.lastUsedAt, null)
    assert.ok(createdBetween(team.createdAt, from, to))
    const orphan = byId.get(`orphan:${"f".repeat(16)}`)!
    assert.equal(orphan.lastUsedAt, null)
    assert.ok(createdBetween(orphan.createdAt, from, to))
    assert.deepEqual([byId.get(`scope:${scope("solo").scopeName}`)!.createdAt, byId.get(`scope:${scope("solo").scopeName}`)!.lastUsedAt], [null, null])

    rmSync(join(roots.homeClientState, "v2", "client-state.json"))
    at(join(roots.tauriDataParent, TAURI_IDENTIFIER, "client-state.json"), used + 9_000)
    assert.equal((await list()).get("default")!.lastUsedAt, used + 9_000)
  } finally {
    context.cleanup()
  }
})

test("a creation date comes from a reliable birth time only", () => {
  assert.equal(reliableBirthTime({ birthtimeMs: 1_700_000_000_123.9, ctimeMs: 1_700_000_100_000 }, "win32"), 1_700_000_000_123)
  assert.equal(reliableBirthTime({ birthtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000 }, "darwin"), 1_700_000_000_000)
  assert.equal(reliableBirthTime({ birthtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_100_000 }, "linux"), 1_700_000_000_000)
  // Linux without btime reports 0, or the change time when statx is unavailable.
  assert.equal(reliableBirthTime({ birthtimeMs: 0, ctimeMs: 1_700_000_100_000 }, "linux"), null)
  assert.equal(reliableBirthTime({ birthtimeMs: 1_700_000_100_000, ctimeMs: 1_700_000_100_000 }, "linux"), null)
  assert.equal(reliableBirthTime({ birthtimeMs: Number.NaN, ctimeMs: 0 }, "win32"), null)
})

test("the open profile is described from the folders deletion would remove for it", async () => {
  const from = Date.now() - 2_000
  const context = populated()
  const to = Date.now() + 2_000
  try {
    const { roots, scope } = context
    const used = Date.UTC(2026, 9, 2)
    at(join(roots.electronBase, "scopes", scope("dev").scopeName, "client-state", "client-state.json"), used)
    at(join(roots.homeClientState, "v2", "client-state.json"), used + 1_000)
    const named = (await listOtherProfiles(roots, current("dev"), dependencies())).current
    // Electron/client-state folder (5), WebView folder (5) and Tauri lock folder (0).
    assert.deepEqual([named.name, named.sizeBytes, named.sizeComplete, named.lastUsedAt], ["dev", 10, true, used])
    assert.ok(createdBetween(named.createdAt, from, to), String(named.createdAt))
    const byDefault = (await listOtherProfiles(roots, current("stable"), dependencies())).current
    assert.deepEqual([byDefault.name, byDefault.sizeBytes, byDefault.sizeComplete, byDefault.lastUsedAt], ["default", 1000 + 20 + 30 + 40 + 400 + 60, true, used + 1_000])
    assert.ok(createdBetween(byDefault.createdAt, from, to), String(byDefault.createdAt))
    // The default profile of another configuration is a scope that does not exist yet.
    assert.deepEqual((await listOtherProfiles(roots, current("stable", OTHER_CONFIG), dependencies())).current, {
      name: "default", sizeBytes: 0, sizeComplete: true, createdAt: null, lastUsedAt: null,
    })
  } finally {
    context.cleanup()
  }
})

test("the listing reports the next launch's remembered profile and whether a choice can apply", async () => {
  const context = populated()
  try {
    const choices = join(context.roots.electronBase, "profile-selection", "choices.json")
    const list = (profile = current("dev")) => listOtherProfiles(context.roots, profile, dependencies())
    // An empty (corrupt) or missing file remembers nothing.
    assert.equal((await list()).nextLaunch, null)
    rmSync(choices)
    assert.equal((await list()).nextLaunch, null)
    writeFileSync(choices, JSON.stringify({ version: 1, choices: { [choiceKey(CONFIG)]: "dev-v2", [choiceKey(OTHER_CONFIG)]: "team" } }))
    assert.equal((await list()).nextLaunch, "dev-v2")
    assert.equal((await list(current("dev", OTHER_CONFIG))).nextLaunch, "team")
    assert.equal((await list(current("dev", "/third/config.yaml"))).nextLaunch, null)
    writeFileSync(choices, JSON.stringify({ version: 1, choices: { [choiceKey(CONFIG)]: "Stable" } }))
    assert.equal((await list()).nextLaunch, "default")
    writeFileSync(choices, JSON.stringify({ version: 2, choices: { [choiceKey(CONFIG)]: "dev" } }))
    assert.equal((await list()).nextLaunch, null)
    assert.equal((await list()).pinned, false)
    assert.equal((await list({ ...current("dev"), pinned: true })).pinned, true)
  } finally {
    context.cleanup()
  }
})

test("profiles open in Electron or Tauri, or in an unknown state, are reported and never deleted", async () => {
  const cases: Array<[string, (context: ReturnType<typeof fixture>, scopeName: string) => void, string]> = [
    ["electron marker", (c, s) => c.file(join(c.roots.electronBase, "scopes", s, `client-state.running.${LIVE}.token.json`)), "in-use"],
    ["electron primary lock", (c, s) => writeFileSync(join(c.roots.electronBase, "scopes", s, "client-state.primary.lock"), JSON.stringify({ pid: LIVE, runToken: "t" })), "in-use"],
    // requestSingleInstanceLock runs while userData is the profile folder itself.
    ["chromium singleton", (c, s) => c.file(join(c.roots.electronBase, "scopes", s, "lockfile")), "in-use"],
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

test("Chromium's singleton is read in the profile folder: POSIX SingletonLock targets are matched by host and PID", async (t) => {
  const context = populated()
  try {
    const scope = join(context.roots.electronBase, "scopes", context.scope("dev-v2").scopeName)
    const id = `scope:${context.scope("dev-v2").scopeName}`
    const status = async () => (await listOtherProfiles(context.roots, current("dev"), dependencies({ hostname: () => "box" })))
      .profiles.find((profile) => profile.id === id)!.status
    // Nothing creates a process singleton in Chromium's storage folder; it is not evidence.
    context.file(join(scope, "developer-mode-browser-v2", "lockfile"))
    assert.equal(await status(), "available")
    const lock = join(scope, "SingletonLock")
    try { symlinkSync(`box-${LIVE}`, lock) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks unavailable")
      throw error
    }
    symlinkSync("/tmp/scoped_dir/SingletonSocket", join(scope, "SingletonSocket"))
    assert.equal(await status(), "in-use", "a live PID of this host")
    for (const [target, expected] of [["box-9999", "available"], [`other-${LIVE}`, "unknown"], ["box", "unknown"], ["box-12x", "unknown"]] as const) {
      unlinkSync(lock)
      symlinkSync(target, lock)
      assert.equal(await status(), expected, target)
    }
    // A dangling stale lock of this host does not block deletion; the folder and its links go.
    unlinkSync(lock)
    symlinkSync("box-9999", lock)
    const result = await deleteOtherProfiles(context.roots, current("dev"), [id], dependencies({ hostname: () => "box" }))
    assert.equal(result.results[0]!.outcome, "deleted")
  } finally {
    context.cleanup()
  }
})

test("a link nested inside a deleted profile is removed without touching its target", async () => {
  const context = populated()
  const outside = mkdtempSync(join(tmpdir(), "codenomad-profile-nested-"))
  try {
    writeFileSync(join(outside, "precious"), "keep")
    const scopeName = context.scope("dev-v2").scopeName
    const nestedElectron = join(context.roots.electronBase, "scopes", scopeName, "client-state", "linked")
    const nestedWebview = join(context.roots.webviewRoot, "scopes", scopeName, "EBWebView", "linked")
    symlinkSync(outside, nestedElectron, "junction")
    symlinkSync(outside, nestedWebview, "junction")
    const result = await deleteOtherProfiles(context.roots, current("dev"), [`scope:${scopeName}`], dependencies())
    assert.equal(result.results[0]!.outcome, "deleted")
    assert.ok(!existsSync(join(context.roots.electronBase, "scopes", scopeName)))
    assert.equal(readFileSync(join(outside, "precious"), "utf8"), "keep")
  } finally {
    context.cleanup()
    rmSync(outside, { recursive: true, force: true })
  }
})

test("macOS listings disclose that Tauri's WebKit storage is shared and kept", async () => {
  const context = populated()
  try {
    assert.equal((await listOtherProfiles(context.roots, current("dev"), dependencies({ platform: "darwin" }))).sharedWebKitStorage, true)
    assert.equal((await listOtherProfiles(context.roots, current("dev"), dependencies({ platform: "win32" }))).sharedWebKitStorage, false)
    assert.equal((await listOtherProfiles(context.roots, current("dev"), dependencies({ platform: "linux" }))).sharedWebKitStorage, false)
  } finally {
    context.cleanup()
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

test("the open configuration forgets its choice of a profile deleted for it, even if other configurations keep that name", async () => {
  const context = populated()
  try {
    const selection = join(context.roots.electronBase, "profile-selection")
    context.file(join(context.roots.electronBase, "scopes", context.scope("team").scopeName, "x"), 1)
    const choices = { [choiceKey(CONFIG)]: "team", [choiceKey(OTHER_CONFIG)]: "team" }
    writeFileSync(join(selection, "choices.json"), JSON.stringify({ version: 1, choices }))
    const result = await deleteOtherProfiles(context.roots, current("dev"), [`scope:${context.scope("team").scopeName}`], dependencies())
    assert.equal(result.choices, "updated")
    assert.deepEqual(JSON.parse(readFileSync(join(selection, "choices.json"), "utf8")).choices, { [choiceKey(OTHER_CONFIG)]: "team" })
    // Deleting another configuration's profile never touches the open configuration's choice.
    writeFileSync(join(selection, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey(CONFIG)]: "team" } }))
    context.file(join(context.roots.electronBase, "scopes", context.scope("team").scopeName, "x"), 1)
    context.file(join(context.roots.electronBase, "scopes", context.scope("team", "/third/config.yaml").scopeName, "x"), 1)
    const other = await deleteOtherProfiles(context.roots, current("dev"), [`scope:${context.scope("team", OTHER_CONFIG).scopeName}`], dependencies())
    assert.equal(other.choices, "unchanged")
  } finally {
    context.cleanup()
  }
})

test("a linked scope, present or dangling, keeps other configurations' remembered name", async () => {
  for (const dangling of [false, true]) {
    const context = populated()
    const outside = mkdtempSync(join(tmpdir(), "codenomad-profile-linked-"))
    try {
      const selection = join(context.roots.electronBase, "profile-selection")
      // Another configuration opens `team` through a link; this one deletes its own plain `team`.
      symlinkSync(outside, join(context.roots.electronBase, "scopes", context.scope("team", "/third/config.yaml").scopeName), "junction")
      if (dangling) rmSync(outside, { recursive: true })
      context.file(join(context.roots.electronBase, "scopes", context.scope("team").scopeName, "x"), 1)
      writeFileSync(join(selection, "choices.json"), JSON.stringify({ version: 1, choices: { [choiceKey("/third/config.yaml")]: "team" } }))
      const id = `scope:${context.scope("team", OTHER_CONFIG).scopeName}`
      const result = await deleteOtherProfiles(context.roots, current("dev"), [`scope:${context.scope("team").scopeName}`, id], dependencies())
      assert.deepEqual(result.results.map((entry) => entry.outcome), ["deleted", "deleted"], `dangling=${dangling}`)
      assert.equal(result.choices, "unchanged", `dangling=${dangling}`)
      assert.match(readFileSync(join(selection, "choices.json"), "utf8"), /team/)
      // The link itself is never listed as deletable.
      const { profiles } = await listOtherProfiles(context.roots, current("dev"), dependencies())
      assert.ok(!profiles.some((profile) => profile.id === `scope:${context.scope("team", "/third/config.yaml").scopeName}`))
    } finally {
      context.cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  }
})

function nextLaunch() {
  const context = fixture()
  const selection = join(context.roots.electronBase, "profile-selection")
  const stored = () => JSON.parse(readFileSync(join(selection, "choices.json"), "utf8")).choices
  const set = (name: unknown, profile = current("dev")) => setNextLaunchProfile(context.roots, profile, name, dependencies())
  const folder = (key: string, config = CONFIG) => join(context.roots.electronBase, "scopes", context.scope(key, config).scopeName)
  return { ...context, selection, stored, set, folder }
}

test("choosing the next launch's profile remembers it for the open configuration and prepares a new profile's folder", async () => {
  const context = nextLaunch()
  try {
    const { set, stored, folder, selection } = context
    // A new name gets its folder for this configuration, so the next launch keeps the choice.
    assert.deepEqual(await set("  Team "), { outcome: "updated" })
    assert.deepEqual(stored(), { [choiceKey(CONFIG)]: "team" })
    assert.ok(statSync(folder("team")).isDirectory())
    // An explicit choice replaces the remembered one; `stable` and `default` name the default profile and need no folder.
    assert.deepEqual(await set("stable"), { outcome: "updated" })
    assert.deepEqual(stored(), { [choiceKey(CONFIG)]: "default" })
    assert.deepEqual(await set("Default", current("dev", OTHER_CONFIG)), { outcome: "updated" })
    assert.deepEqual(stored(), { [choiceKey(CONFIG)]: "default", [choiceKey(OTHER_CONFIG)]: "default" })
    assert.ok(!existsSync(folder("stable", OTHER_CONFIG)))
    // An existing profile keeps its folder and content.
    context.file(join(folder("dev-v2"), "client-state", "client-state.json"), 3)
    assert.deepEqual(await set("dev-v2"), { outcome: "updated" })
    assert.equal(readFileSync(join(folder("dev-v2"), "client-state", "client-state.json"), "utf8"), "xxx")
    assert.deepEqual(stored(), { [choiceKey(CONFIG)]: "dev-v2", [choiceKey(OTHER_CONFIG)]: "default" })
    // Names outside the CODENOMAD_PROFILE grammar change nothing.
    for (const invalid of ["", "  ", "../x", "-dev", "a".repeat(65), "Émile", "C:\\Users", 7, null, ["dev"]]) {
      assert.deepEqual(await set(invalid), { outcome: "invalid" }, String(invalid))
    }
    assert.deepEqual(stored(), { [choiceKey(CONFIG)]: "dev-v2", [choiceKey(OTHER_CONFIG)]: "default" })
    // No lock or temporary file is left behind.
    assert.deepEqual(readdirSync(selection), ["choices.json"])
  } finally {
    context.cleanup()
  }
})

test("a chosen profile's existing entry, link or not, is left as it is", async () => {
  const context = nextLaunch()
  const outside = mkdtempSync(join(tmpdir(), "codenomad-profile-next-"))
  try {
    const { set, stored, folder } = context
    mkdirSync(dirname(folder("linked")), { recursive: true })
    symlinkSync(outside, folder("linked"), "junction")
    rmSync(outside, { recursive: true })
    assert.deepEqual(await set("linked"), { outcome: "updated" })
    assert.ok(lstatSync(folder("linked")).isSymbolicLink())
    assert.ok(!existsSync(outside), "nothing is created through a dangling link")
    writeFileSync(folder("plain-file"), "x")
    assert.deepEqual(await set("plain-file"), { outcome: "updated" })
    assert.equal(readFileSync(folder("plain-file"), "utf8"), "x")
    assert.deepEqual(stored(), { [choiceKey(CONFIG)]: "plain-file" })
  } finally {
    context.cleanup()
    rmSync(outside, { recursive: true, force: true })
  }
})

test("choosing the next launch's profile is busy while a launch holds the lock and never rewrites a newer or full file", async () => {
  const context = nextLaunch()
  try {
    const { set, folder, selection } = context
    const choices = join(selection, "choices.json")
    const lock = join(selection, "choices.lock")
    mkdirSync(selection, { recursive: true })
    // A launch choosing its profile holds the lock: nothing is written or prepared.
    writeFileSync(lock, JSON.stringify({ pid: 1, token: "launch" }))
    assert.deepEqual(await set("team"), { outcome: "busy" })
    assert.ok(!existsSync(choices))
    assert.ok(!existsSync(folder("team")))
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "launch")
    // A lock left by a crashed launch is taken over.
    at(lock, Date.now() - LOCK_STALE_MS - 5_000)
    assert.deepEqual(await set("team"), { outcome: "updated" })
    assert.ok(!existsSync(lock))

    const future = JSON.stringify({ version: 2, choices: {} })
    writeFileSync(choices, future)
    assert.deepEqual(await set("dev-v2"), { outcome: "failed" })
    assert.equal(readFileSync(choices, "utf8"), future)
    assert.ok(!existsSync(folder("dev-v2")))

    const full: Record<string, string> = {}
    for (let index = 0; index < 256; index += 1) full[choiceKey(`/other/${index}/config.yaml`)] = "dev"
    writeFileSync(choices, JSON.stringify({ version: 1, choices: full }))
    assert.deepEqual(await set("dev-v2"), { outcome: "failed" })
    assert.ok(!existsSync(folder("dev-v2")))
    // This configuration's own entry is replaced in place even in a full file.
    writeFileSync(choices, JSON.stringify({ version: 1, choices: { ...full, [choiceKey(`/other/0/config.yaml`)]: "team" } }))
    assert.deepEqual(await set("dev-v2", current("dev", "/other/0/config.yaml")), { outcome: "updated" })

    // An unwritable file fails and leaves no empty folder for the new name.
    rmSync(choices)
    mkdirSync(choices)
    assert.deepEqual(await set("fresh"), { outcome: "failed" })
    assert.ok(!existsSync(folder("fresh")))
    assert.deepEqual(readdirSync(selection), ["choices.json"])
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
