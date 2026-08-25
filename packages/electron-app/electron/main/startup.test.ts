import assert from "node:assert/strict"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { allocateLocalWindowIdentity, BackendBootstrapCoordinator, createLaunchIntentQueue, isRemoteCertificateAllowed, parseLaunchIntent, resolveRemoteSessionPartition, resolveStorageScope, resolveUpdateChannel, startPrimaryInstance } from "./startup"

test("update channel honors the environment, forces unpackaged dev, and only infers packaged versions", () => {
  assert.equal(resolveUpdateChannel("Beta", "1.0.0-dev.2", false), "beta")
  assert.equal(resolveUpdateChannel(undefined, "1.0.0", false), "dev")
  assert.equal(resolveUpdateChannel(undefined, "1.0.0-dev-2", true), "dev")
  assert.equal(resolveUpdateChannel(undefined, "1.0.0-dev-v2-2", true), "dev-v2")
  assert.equal(resolveUpdateChannel(undefined, "1.0.0", true), "stable")
})

test("stable default storage preserves paths while dev and alternate configs are scoped", () => {
  const base = join(tmpdir(), "codenomad-startup-base")
  const stable = resolveStorageScope({ appVersion: "1.0.0", cwd: base, baseUserDataPath: base, packaged: true })
  assert.equal(stable.userDataPath, base)
  assert.equal(stable.sessionDataPath, join(base, "session-data-v2"))
  assert.equal(stable.clientStateElectionDirectory, undefined)
  const dev = resolveStorageScope({ appVersion: "1.0.0-dev.1", cwd: base, baseUserDataPath: base, packaged: true })
  const alternate = resolveStorageScope({ appVersion: "1.0.0", cliConfig: "other/config.json", cwd: base, baseUserDataPath: base, packaged: true })
  assert.match(dev.userDataPath, /scopes[\\/]dev-[0-9a-f]{16}$/)
  assert.equal(dev.clientStateElectionDirectory, join(dev.userDataPath, "client-state", "election"))
  assert.match(alternate.userDataPath, /scopes[\\/]stable-[0-9a-f]{16}$/)
  assert.equal(alternate.clientStateElectionDirectory, join(alternate.userDataPath, "client-state", "election"))
  assert.equal(resolveStorageScope({ appVersion: "1.0.0", cliConfig: "other/config.yaml", cwd: base, baseUserDataPath: base, packaged: true }).userDataPath, alternate.userDataPath)
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
