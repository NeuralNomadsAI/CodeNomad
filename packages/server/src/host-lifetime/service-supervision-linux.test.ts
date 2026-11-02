import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { LinuxSupervisionLinger } from "./service-supervision-linux-linger"
import { linuxSupervisionUnit } from "./service-supervision-linux"
import { linuxUnitQuote, type LinuxCommand } from "./service-supervision-linux-native"
import { initialSupervisionManifest, applySupervisionControl, supervisionStatus, type SupervisionManifest, type SupervisionHealth } from "./service-supervision-contract"
import type { StoragePolicy } from "./storage"
import { nativeSupervisionStartPermitted } from "./service-supervision-health"
import type { ProcessState } from "./process-identity"

const policy: StoragePolicy = { async verify(file, directory) {
  const s = await lstat(file)
  assert.equal(s.isSymbolicLink(), false)
  assert.equal(directory ? s.isDirectory() : s.isFile() && s.nlink === 1, true)
} }
function manifest(channel = "service.json"): SupervisionManifest {
  return applySupervisionControl(initialSupervisionManifest({ platform: "linux", host: "host", user: "1000",
    configDirectory: "/home/u/config/opencode", stateDirectory: "/home/u/state/opencode", registrationName: channel },
  { binary: "/home/u/Open Code/opencode", provenance: "custom" }), { action: "on", requestID: randomUUID(), expectedRevision: 0 })
}
const off = (m: SupervisionManifest) => applySupervisionControl(m, { action: "off", requestID: randomUUID(), expectedRevision: m.revision })
async function fixture(t: TestContext, preexisting = false) {
  const parent = path.join(os.tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "linux-supervision-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = { enabled: preexisting, fingerprint: preexisting ? "personal" : null as string | null,
    sessions: "s1", sessionState: "active", health: { state: "healthy", pid: 12, id: "id", startIdentity: "start" } as SupervisionHealth,
    process: { state: "live", startIdentity: "start" } as ProcessState,
    identity: { pid: 12, id: "id", startIdentity: "start" } as { pid: number; id: string; startIdentity: string } | null,
    refuse: false, loseAck: false, commands: [] as string[] }
  const command: LinuxCommand = async (binary, args) => {
    assert.equal(binary, "/usr/bin/loginctl")
    state.commands.push(args.join(" "))
    if (args.includes("enable-linger")) {
      assert.equal(args[0], "--no-ask-password")
      if (state.refuse) throw new Error("private polkit error")
      state.enabled = true; state.fingerprint = "owned"
      if (state.loseAck) throw new Error("lost acknowledgement")
      return ""
    }
    if (args.includes("disable-linger")) { state.enabled = false; state.fingerprint = null; return "" }
    if (args.includes("--property=Linger")) return state.enabled ? "yes" : "no"
    if (args.includes("--property=Sessions")) return state.sessions
    if (args.includes("--property=State")) return state.sessionState
    throw new Error("unexpected command")
  }
  let active = false
  const reopen = () => new LinuxSupervisionLinger(root, "1000", "host", "u", policy, { command,
    fingerprint: async () => state.fingerprint, health: async () => state.health,
    lookup: async () => state.process, identity: async () => state.identity,
    lock: async (_file, run) => { if (active) throw new Error("busy"); active = true; try { return await run() } finally { active = false } } })
  return { root, state, linger: reopen(), reopen }
}

test("Linux unit is foreground, restart bounded by systemd, KillMode process, with escaped fixed argv and no credentials", () => {
  const unit = linuxSupervisionUnit(manifest().key, "/home/u/Code Nomad/manifest", {
    node: "/home/u/runtime/node", guard: "/home/u/runtime/guard.cjs", unitDirectory: "/home/u/.config/systemd/user",
    environment: { HOME: "/home/u", XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state", XDG_DATA_HOME: "/data", XDG_CACHE_HOME: "/cache" } })
  for (const value of ["Restart=always", "RestartSec=2", "StartLimitIntervalSec=60", "StartLimitBurst=5", "KillMode=process", "WantedBy=default.target", '"/home/u/Code Nomad/manifest"']) assert.ok(unit.includes(value))
  assert.ok(!/password|token|OPENCODE_CONFIG_CONTENT|service start/i.test(unit))
  assert.equal(linuxUnitQuote('/a%u/$HOME/"b'), '"/a%%u/$$HOME/\\"b"')
  assert.throws(() => linuxUnitQuote("/a\nExecStart=/bad"))
})
test("linger ownership survives profiles, is deduplicated, and last OFF restores it", async t => {
  const { linger, state, root } = await fixture(t), a = manifest(), b = manifest("service-other.json")
  assert.equal(await linger.reconcile(a), "enabled")
  assert.equal(await linger.reconcile(a), "enabled")
  assert.equal(await linger.reconcile(b), "enabled")
  assert.equal(await linger.reconcile(off(a)), "enabled")
  assert.equal(state.enabled, true)
  assert.equal(await linger.reconcile(off(b)), "disabled")
  assert.equal(state.enabled, false)
  assert.equal(state.commands.filter(c => c.includes("enable-linger")).length, 1)
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "linux-linger.json"), "utf8")).requests, [])
})
test("personal linger is never claimed or disabled", async t => {
  const { linger, state } = await fixture(t, true), m = manifest()
  assert.equal(await linger.reconcile(m), "external")
  assert.equal(await linger.reconcile(off(m)), "external")
  assert.equal(state.commands.some(c => c.includes("disable-linger")), false)
})
test("OFF without an open session preserves a released healthy/unknown process and visibly defers linger rollback", async t => {
  const { linger, state } = await fixture(t), m = manifest()
  await linger.reconcile(m); state.sessions = ""
  assert.equal(await linger.reconcile(off(m)), "deferred")
  assert.equal(await linger.observe(), "deferred")
  state.health = { state: "unknown" }
  assert.equal(await linger.reconcile(off(m)), "deferred")
  assert.equal(state.enabled, true)
  state.health = { state: "absent" }
  state.process = { state: "dead" }
  assert.equal(await linger.reconcile(off(m)), "disabled")
})
test("a new ON cancels deferred rollback; closing sessions do not authorize disable", async t => {
  const { linger, state } = await fixture(t), m = manifest()
  await linger.reconcile(m); state.sessionState = "closing"
  assert.equal(await linger.reconcile(off(m)), "deferred")
  assert.equal(await linger.reconcile(m), "enabled")
  assert.equal(state.commands.some(c => c.includes("disable-linger")), false)
  state.sessionState = "online"
  assert.equal(await linger.observe(), "enabled")
  assert.equal(state.commands.some(c => c.includes("disable-linger")), false)
  assert.equal(await linger.reconcile(off(m)), "disabled")
})
test("passive reconciliation completes deferred OFF when a session opens or the released service ends", async t => {
  for (const safe of ["session", "exit"] as const) {
    const { linger, state } = await fixture(t), m = manifest()
    await linger.reconcile(m); state.sessions = ""
    assert.equal(await linger.reconcile(off(m)), "deferred")
    assert.equal(await linger.observe(), "deferred")
    if (safe === "session") { state.sessions = "s1"; state.sessionState = "online" }
    else { state.health = { state: "absent" }; state.process = { state: "dead" } }
    // No Retry or second OFF: startup and status reconciliation own this cleanup.
    await linger.reconcileDeferred()
    assert.equal(await linger.observe(), "disabled")
    assert.equal(state.commands.filter(c => c.includes("disable-linger")).length, 1)
  }
})
test("deleted registration never proves a released process ended; durable PID/start identity fences deferred cleanup", async t => {
  const { linger, state, root, reopen } = await fixture(t), m = manifest()
  await linger.reconcile(m)
  await linger.retainReleased(off(m))
  const retained = JSON.parse(await readFile(path.join(root, "linux-linger.json"), "utf8")).released[0]
  assert.deepEqual(retained.process, state.identity)
  assert.equal(retained.registration, "/home/u/state/opencode/service.json")
  state.sessions = ""; state.health = { state: "absent" }; state.identity = null
  assert.equal(await linger.reconcile(off(m)), "deferred")
  const restarted = reopen()
  assert.equal(await restarted.observe(), "deferred", "missing registration + live retained PID stays deferred after restart")
  state.process = { state: "unknown" }
  assert.equal(await restarted.observe(), "deferred")
  state.process = { state: "live", startIdentity: "reused-pid" }
  assert.equal(await restarted.observe(), "disabled", "a different native start proves the retained incarnation ended")
})
test("missing release identity remains unknown even when registration is absent and sessions are closed", async t => {
  const { linger, state } = await fixture(t), m = manifest()
  await linger.reconcile(m)
  state.sessions = ""; state.health = { state: "absent" }; state.identity = null; state.process = { state: "dead" }
  assert.equal(await linger.reconcile(off(m)), "deferred")
  assert.equal(await linger.observe(), "deferred")
  assert.equal(state.commands.some(c => c.includes("disable-linger")), false)
  state.sessions = "s1"
  assert.equal(await linger.observe(), "disabled")
})
test("automatic deferred cleanup preserves new ON consumers and changed ownership", async t => {
  const { linger, state } = await fixture(t), m = manifest()
  await linger.reconcile(m); state.sessions = ""
  await linger.reconcile(off(m))
  state.fingerprint = "changed"; state.health = { state: "absent" }
  assert.equal(await linger.observe(), "uncertain")
  assert.equal(state.commands.some(c => c.includes("disable-linger")), false)
})
test("polkit refusal keeps requested ON and fixed diagnostic; Retry can enable without elevation", async t => {
  const { linger, state, root } = await fixture(t), m = manifest()
  state.refuse = true
  assert.equal(await linger.reconcile(m), "permission-required")
  assert.equal(await linger.observe(), "permission-required")
  const bytes = await readFile(path.join(root, "linux-linger.json"), "utf8")
  assert.ok(bytes.includes(m.key)); assert.ok(!bytes.includes("private polkit"))
  state.refuse = false
  assert.equal(await linger.reconcile(m), "enabled")
  assert.equal(state.commands.some(c => /sudo|pkexec/.test(c)), false)
})
test("lost enable ACK and externally changed owned marker preserve linger as uncertain", async t => {
  const { linger, state } = await fixture(t), m = manifest()
  state.loseAck = true
  assert.equal(await linger.reconcile(m), "permission-required")
  state.loseAck = false
  assert.equal(await linger.reconcile(m), "uncertain")
  assert.equal(await linger.reconcile(off(m)), "uncertain")
  assert.equal(state.enabled, true)
  assert.equal(state.commands.some(c => c.includes("disable-linger")), false)
})
test("external marker replacement cannot authorize rollback", async t => {
  const { linger, state } = await fixture(t), m = manifest()
  await linger.reconcile(m); state.fingerprint = "someone-else"
  assert.equal(await linger.observe(), "uncertain")
  assert.equal(await linger.reconcile(off(m)), "uncertain")
  assert.equal(state.enabled, true)
})
test("corrupt registry refuses all mutations", async t => {
  const { linger, root, state } = await fixture(t)
  await writeFile(path.join(root, "linux-linger.json"), '{"v":2}', { mode: 0o600 })
  await assert.rejects(linger.reconcile(manifest()))
  assert.equal(state.commands.length, 0)
})
test("status distinguishes OFF deferred rollback, unknown provenance and polkit refusal", () => {
  const m = manifest(), stopped = { ...off(m), reconciledRevision: 2 }
  const base = { revision: 2, resources: "absent" as const, guard: "absent" as const, health: { state: "absent" as const } }
  assert.deepEqual([supervisionStatus(stopped, { ...base, linuxLinger: "deferred" }).state,
    supervisionStatus(stopped, { ...base, linuxLinger: "deferred" }).cause], ["off", "linux-linger-deferred"])
  assert.equal(supervisionStatus(stopped, { ...base, linuxLinger: "uncertain" }).cause, "linux-linger-uncertain")
  assert.equal(supervisionStatus(m, { ...base, revision: 1, linuxLinger: "permission-required" }).cause, "linux-linger-permission-required")
  assert.equal(supervisionStatus(stopped, { ...base, resources: "installed", linuxLinger: "deferred" }).state, "failing")
})
test("native start gate admits absent/false config and refuses disabled, malformed and incomplete reads", async t => {
  const { root } = await fixture(t), file = path.join(root, "native-service.json")
  assert.equal(await nativeSupervisionStartPermitted(file), true)
  for (const [bytes, permitted] of [["{}", true], ['{"disabled":false}', true], ['{"disabled":true}', false],
    ['{"disabled":"false"}', false], ["{", false], ["null", false]] as const) {
    await writeFile(file, bytes)
    assert.equal(await nativeSupervisionStartPermitted(file), permitted)
  }
  assert.equal(await nativeSupervisionStartPermitted(root), false)
})
