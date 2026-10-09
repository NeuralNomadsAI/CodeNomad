import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { allocateLocalWindowIdentity, BackendBootstrapCoordinator, createLaunchIntentQueue, isRemoteCertificateAllowed, parseLaunchIntent, prepareSecondLaunchIntent, resolveLaunchProfile, resolveRemoteSessionPartition, resolveStorageScope, startPrimaryInstance } from "./startup"

test("default profile storage preserves paths while named profiles and alternate configs are scoped", () => {
  const base = join(tmpdir(), "codenomad-startup-base")
  const stable = resolveStorageScope({ profileKey: "stable", cwd: base, baseUserDataPath: base, packaged: true })
  assert.equal(stable.userDataPath, base)
  assert.equal(stable.sessionDataPath, join(base, "session-data-v2"))
  assert.equal(stable.clientStateElectionDirectory, undefined)
  const dev = resolveStorageScope({ profileKey: "dev", cwd: base, baseUserDataPath: base, packaged: true })
  const alternate = resolveStorageScope({ profileKey: "stable", cliConfig: "other/config.json", cwd: base, baseUserDataPath: base, packaged: true })
  assert.match(dev.userDataPath, /scopes[\\/]dev-[0-9a-f]{16}$/)
  assert.equal(dev.clientStateElectionDirectory, join(dev.userDataPath, "client-state", "election"))
  assert.match(alternate.userDataPath, /scopes[\\/]stable-[0-9a-f]{16}$/)
  assert.equal(alternate.clientStateElectionDirectory, join(alternate.userDataPath, "client-state", "election"))
  assert.equal(resolveStorageScope({ profileKey: "stable", cliConfig: "other/config.yaml", cwd: base, baseUserDataPath: base, packaged: true }).userDataPath, alternate.userDataPath)
})

test("launch profile: explicit settings skip the transition, packaged launches without them use it", () => {
  const base = join(tmpdir(), "codenomad-startup-base")
  let transitions = 0
  const transition = () => { transitions++; return { kind: "resolved" as const, key: "dev", reason: "single" as const } }
  const launch = (environment: Record<string, string | undefined>, packaged: boolean) =>
    resolveLaunchProfile({ environment, packaged, cwd: base, baseUserDataPath: base, transition })
  assert.deepEqual(launch({ CODENOMAD_PROFILE: "Team", CODENOMAD_UPDATE_CHANNEL: "dev" }, true), { kind: "ready", key: "team", source: "profile" })
  assert.deepEqual(launch({ CODENOMAD_UPDATE_CHANNEL: "dev-v2" }, true), { kind: "ready", key: "dev-v2", source: "legacy-channel" })
  assert.deepEqual(launch({}, false), { kind: "ready", key: "dev", source: "unpackaged" })
  assert.equal(transitions, 0)
  assert.deepEqual(launch({}, true), { kind: "ready", key: "dev", source: "transition" })
  assert.equal(transitions, 1)
  assert.throws(() => launch({ CODENOMAD_PROFILE: "not a profile" }, true), /Invalid CODENOMAD_PROFILE/)
})

test("remote profiles use isolated persistent partitions and TLS exceptions stay with their webContents", () => {
  const first = resolveRemoteSessionPartition("profile-a")
  assert.match(first, /^persist:codenomad-remote-[0-9a-f]{24}$/)
  assert.equal(resolveRemoteSessionPartition("profile-a"), first)
  assert.notEqual(resolveRemoteSessionPartition("profile-b"), first)
  assert.match(resolveRemoteSessionPartition("profile-a", "proxy-1"), /^codenomad-remote-/)
  const allowlists = new Map([[7, new Set(["https://unsafe.example"])], [8, new Set(["https://other.example"])]] as const)
  assert.equal(isRemoteCertificateAllowed(7, "https://unsafe.example/path", allowlists), true)
  assert.equal(isRemoteCertificateAllowed(8, "https://unsafe.example/path", allowlists), false)
})

test("new local windows reuse retained records and otherwise fall back to ephemeral identities", async () => {
  let additions = 0
  assert.deepEqual(await allocateLocalWindowIdentity(["retained"], () => false, async () => { additions++; return "new" }), { id: "retained", persisted: true })
  assert.equal(additions, 0)
  assert.deepEqual(await allocateLocalWindowIdentity([], () => false, async () => null, undefined, () => "ephemeral"), { id: "ephemeral", persisted: false })
  assert.deepEqual(await allocateLocalWindowIdentity([], () => false, async () => { throw new Error("frozen") }, () => {}, () => "fallback"), { id: "fallback", persisted: false })
})

test("launch intents wait for readiness and remain serialized across async window creation", async () => {
  const calls: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const queue = createLaunchIntentQueue(async (intent) => {
    calls.push(`start:${intent.folders[0]}`)
    if (intent.folders[0] === "first") await firstGate
    calls.push(`end:${intent.folders[0]}`)
  }, (error) => assert.fail(String(error)))
  const first = queue.enqueue({ newWindow: true, folders: ["first"] })
  const second = queue.enqueue({ newWindow: false, folders: ["second"] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [])
  queue.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ["start:first"])
  releaseFirst()
  await Promise.all([first, second, queue.idle()])
  assert.deepEqual(calls, ["start:first", "end:first", "start:second", "end:second"])
})

test("launch arguments resolve valid folders relative to launch cwd and ignore unknown flags", () => {
  const root = join(tmpdir(), `codenomad-launch-${process.pid}`)
  const folder = join(root, "workspace")
  mkdirSync(folder, { recursive: true })
  try {
    assert.deepEqual(parseLaunchIntent(["--ignored", "--new-window", "--folder", "workspace", "missing", "workspace"], root), {
      newWindow: true,
      folders: [folder],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("second launches open a new window unless the profile requests MRU focus", () => {
  const root = join(tmpdir(), `codenomad-second-launch-${process.pid}`)
  const config = join(root, "config.yaml")
  const intent = { newWindow: false, folders: ["workspace"] }
  mkdirSync(root, { recursive: true })
  try {
    assert.equal(prepareSecondLaunchIntent(intent, config).newWindow, true)
    writeFileSync(config, "ui:\n  settings:\n    focusExistingWindowOnSecondLaunch: true\n")
    assert.equal(prepareSecondLaunchIntent(intent, config).newWindow, false)
    writeFileSync(config, "ui: [invalid")
    assert.equal(prepareSecondLaunchIntent(intent, config).newWindow, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a losing native lock quits without primary side effects", () => {
  const calls: string[] = []
  assert.equal(startPrimaryInstance(() => (calls.push("lock"), false), () => calls.push("quit"), () => calls.push("construct")), false)
  assert.deepEqual(calls, ["lock", "quit"])
})

test("bootstrap waits for a same-generation URL and token and discards late completion", async () => {
  const calls: string[] = []
  let release!: (accepted: boolean) => void
  const firstExchange = new Promise<boolean>((resolve) => { release = resolve })
  let exchanges = 0
  const coordinator = new BackendBootstrapCoordinator(
    async (url, token) => { calls.push(`exchange:${url}:${token}`); return exchanges++ === 0 ? firstExchange : true },
    (url) => { calls.push(`navigate:${url}`) },
  )
  coordinator.setReady("http://old")
  assert.deepEqual(calls, [])
  coordinator.setToken("old-token")
  assert.deepEqual(calls, ["exchange:http://old:old-token"])
  coordinator.reset()
  coordinator.setToken("new-token")
  coordinator.setReady("http://new")
  await coordinator.idle()
  release(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ["exchange:http://old:old-token", "exchange:http://new:new-token", "navigate:http://new"])
})
