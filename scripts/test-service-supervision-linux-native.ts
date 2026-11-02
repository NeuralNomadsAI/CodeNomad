// Run only on a disposable Linux systemd VM with a private CLI/XDG sandbox.
// Bundle with esbuild alongside the production guard before copying to the VM.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { readFile, writeFile, lstat, rename } from "node:fs/promises"
import { randomUUID, createHash } from "node:crypto"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { acquireLinuxSupervision } from "../packages/server/src/host-lifetime/service-supervision-linux-resolver"
import { ServiceSupervisionSettings } from "../packages/server/src/host-lifetime/service-supervision-service"
import { readSupervisionHealth } from "../packages/server/src/host-lifetime/service-supervision-health"
import { readNativeScheduleIncarnation } from "../packages/server/src/opencode/missions/native-schedule-transport-identity"
import { linuxCommand } from "../packages/server/src/host-lifetime/service-supervision-linux-native"
import { withLinuxSupervisionLock } from "../packages/server/src/host-lifetime/service-supervision-linux-lock"

async function main() {
  const [phase, root] = process.argv.slice(2)
  assert.equal(process.platform, "linux")
  assert.ok(root && /^\/home\/[^/]+\/cn-host-linux-[A-Za-z0-9-]+$/.test(root))
  assert.equal((await lstat(root)).isSymbolicLink(), false)
  const binary = path.join(root, "bin/opencode"), environment = { PATH: "/usr/bin:/bin", HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache") }
  const scope = await acquireLinuxSupervision({ selectedBinary: () => binary, root: path.join(root, "supervision"),
    environment, guardSource: path.join(root, "guard.cjs") })
  const settings = new ServiceSupervisionSettings(async () => scope), store = scope.store
  const manifest = await store.read(), registration = path.join(manifest.namespace.stateDirectory, manifest.namespace.registrationName)
  const unit = `codenomad-opencode-${manifest.key}.service`
  const result: Record<string, unknown> = { phase, unit, initialBootID: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() }
  async function run(args: string[]) {
    return new Promise<string>((resolve, reject) => execFile(binary, args, { env: environment, timeout: 30_000, maxBuffer: 32768 },
      (error, stdout) => error ? reject(new Error("isolated-cli-failed")) : resolve(stdout.trim())))
  }
  async function control(action: "on" | "off" | "retry") {
    const current = await store.read()
    return settings.control({ action, serviceKey: current.key, requestID: randomUUID(), expectedRevision: current.revision }, () => {})
  }
  async function healthy() {
    const health = await readSupervisionHealth(registration)
    assert.equal(health.state, "healthy")
    if (health.state !== "healthy") throw new Error()
    return health
  }
  async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 25_000) {
    const end = Date.now() + timeout
    while (Date.now() < end) { const value = await read(); if (accepts(value)) return value; await delay(300) }
    throw new Error("qualification-deadline")
  }
  async function running() { return until(() => settings.read(), value => value.state === "running") }
  async function identity() {
    const health = await healthy(), hash = createHash("sha256").update(await readFile(registration)).digest("hex")
    return { ...health, hash }
  }
  if (phase === "denied") {
    const response = await control("on")
    assert.equal(response.desired, "on"); assert.equal(response.state, "failing")
    assert.equal(response.cause, "linux-linger-permission-required")
    assert.equal((await scope.adapter.observe()).resources, "absent")
    result.response = response
  } else if (phase === "on") {
    await control(manifest.desired === "on" ? "retry" : "on")
    result.response = await running(); result.identity = await identity()
  } else if (phase === "off-no-session") {
    await running()
    assert.equal(await linuxCommand("/usr/bin/loginctl", ["show-user", String(process.getuid!()), "--property=Sessions", "--value"]), "")
    const initial = await identity()
    result.off = await control("off")
    assert.equal((result.off as { state: string }).state, "off")
    assert.equal((result.off as { cause: string }).cause, "linux-linger-deferred")
    assert.deepEqual(await identity(), initial)
    assert.equal(await linuxCommand("/usr/bin/loginctl", ["show-user", String(process.getuid!()), "--property=Linger", "--value"]), "yes")
    result.identity = initial
    await writeFile(path.join(root, "off-no-session.json"), JSON.stringify(result), { mode: 0o600 })
  } else if (phase === "restore-deferred") {
    const previous = JSON.parse(await readFile(path.join(root, "off-no-session.json"), "utf8"))
    result.before = await settings.read()
    assert.equal((result.before as { cause: string }).cause, "linux-linger-deferred")
    assert.deepEqual(await identity(), previous.identity)
    result.after = await control("retry")
    assert.equal((result.after as { state: string }).state, "off")
    assert.equal((result.after as { cause: unknown }).cause, null)
    assert.equal(await linuxCommand("/usr/bin/loginctl", ["show-user", String(process.getuid!()), "--property=Linger", "--value"]), "no")
    assert.deepEqual(await identity(), previous.identity)
    result.identity = await identity()
  } else if (phase === "disabled") {
    await running()
    await run(["service", "set", "disabled", "true"])
    result.disabled = await until(() => settings.read(), value => value.cause === "native-service-disabled-or-unknown")
    await delay(3000)
    assert.equal((await readSupervisionHealth(registration)).state, "absent")
    await run(["service", "unset", "disabled"])
    result.restored = await running(); result.identity = await identity()
  } else if (phase === "exercise") {
    await running()
    const initial = await identity(); result.hosted = initial
    // A real live but unreachable owned service must recover with no kill/spawn.
    process.kill(initial.pid, "SIGSTOP")
    try {
      await delay(40_000)
      assert.deepEqual(readNativeScheduleIncarnation(registration).id, initial.id)
      assert.equal((await settings.read()).state, "failing")
    } finally { process.kill(initial.pid, "SIGCONT") }
    await running(); assert.deepEqual(await identity(), initial)
    result.hostedUnreachable40s = "same PID/id/start/registration; health recovered"
    const beforeGroup = await readFile(`/proc/${initial.pid}/cgroup`, "utf8")
    result.off = await control("off")
    assert.equal((result.off as { state: string }).state, "off")
    assert.deepEqual(await identity(), initial)
    result.offCgroup = { before: beforeGroup.trim(), after: (await readFile(`/proc/${initial.pid}/cgroup`, "utf8")).trim() }
    assert.equal((await scope.adapter.observe()).resources, "absent")
    await control("on"); await running(); assert.deepEqual(await identity(), initial)
    result.adopted = await identity()
    process.kill(initial.pid, "SIGSTOP")
    try { await delay(40_000); assert.equal(readNativeScheduleIncarnation(registration).id, initial.id) }
    finally { process.kill(initial.pid, "SIGCONT") }
    await running(); assert.deepEqual(await identity(), initial)
    result.incumbentUnreachable40s = "same PID/id/start/registration; health recovered"
    let started = Date.now()
    process.kill(initial.pid, "SIGKILL")
    const crashed = await until(() => readSupervisionHealth(registration), value => value.state === "healthy" && value.id !== initial.id)
    result.serviceCrash = { elapsedMs: Date.now() - started, health: crashed }
    await run(["service", "stop"]); started = Date.now()
    const stopped = await until(() => readSupervisionHealth(registration), value => value.state === "healthy" && value.state === crashed.state && "id" in crashed && value.id !== crashed.id)
    result.serviceStop = { elapsedMs: Date.now() - started, health: stopped }
    await run(["service", "restart"])
    const restarted = await healthy(); await delay(5000); assert.deepEqual(await healthy(), restarted)
    result.restartAdopted = restarted
    const guardBefore = Number(await linuxCommand("/usr/bin/systemctl", ["--user", "show", unit, "--property=MainPID", "--value"]))
    started = Date.now(); process.kill(guardBefore, "SIGKILL")
    await until(async () => Number(await linuxCommand("/usr/bin/systemctl", ["--user", "show", unit, "--property=MainPID", "--value"])), value => value > 0 && value !== guardBefore)
    await running(); assert.deepEqual(await healthy(), restarted)
    result.guardCrash = { elapsedMs: Date.now() - started, sameService: true }
    // Real StartLimit on guard crashes, independent of the service retry backoff.
    // Fail the actual guard before initialization. Ubuntu 255 keeps its original
    // exit-code Result after rate limiting; ActiveState + journal prove the limit.
    const descriptor = path.join(store.directory, "linux.json")
    await rename(descriptor, `${descriptor}.saved`)
    try {
      const pid = Number(await linuxCommand("/usr/bin/systemctl", ["--user", "show", unit, "--property=MainPID", "--value"]))
      process.kill(pid, "SIGKILL")
      await until(() => linuxCommand("/usr/bin/systemctl", ["--user", "show", unit, "--property=ActiveState", "--value"]), value => value === "failed")
      const restarts = Number(await linuxCommand("/usr/bin/systemctl", ["--user", "show", unit, "--property=NRestarts", "--value"]))
      assert.ok(restarts >= 5)
      assert.deepEqual(await healthy(), restarted)
      result.startLimit = { restarts, state: "failed", servicePreserved: true }
    } finally { await rename(`${descriptor}.saved`, descriptor) }
    await control("retry"); await running()
    result.readyForReboot = await identity()
    await writeFile(path.join(root, "before-reboot.json"), JSON.stringify(result), { mode: 0o600 })
  } else if (phase === "boot") {
    await running()
    const before = JSON.parse(await readFile(path.join(root, "before-reboot.json"), "utf8"))
    assert.notEqual(result.initialBootID, before.initialBootID)
    const status = JSON.parse(await readFile(path.join(store.directory, "linux-status.json"), "utf8"))
    assert.equal(status.firstHealthy.id, (await healthy()).id)
    const sessions = (await linuxCommand("/usr/bin/loginctl", ["show-user", String(process.getuid!()), "--property=Sessions", "--value"])).split(/\s+/).filter(Boolean)
    const sessionTimes = []
    for (const id of sessions) sessionTimes.push({ id, microseconds: Number(await linuxCommand("/usr/bin/loginctl", ["show-session", id, "--property=TimestampMonotonic", "--value"])) })
    result.timestamps = { healthyBootSeconds: status.firstHealthy.bootSeconds, sessions: sessionTimes,
      userManager: await linuxCommand("/usr/bin/systemctl", ["show", `user@${process.getuid!()}.service`, "--property=ActiveEnterTimestampMonotonic", "--value"]),
      unit: await linuxCommand("/usr/bin/systemctl", ["--user", "show", unit, "--property=ActiveEnterTimestampMonotonic", "--value"]) }
    result.beforeEveryLogin = sessionTimes.every(session => session.microseconds > status.firstHealthy.bootSeconds * 1_000_000)
    result.identity = await identity()
    // Retain the result even when the configured autologin wins the boot race.
    await writeFile(path.join(root, "boot.json"), JSON.stringify(result), { mode: 0o600 })
    assert.equal(result.beforeEveryLogin, true, "healthy service must precede every login, including autologin")
  } else if (phase === "cleanup") {
    result.off = await control("off")
    await run(["service", "stop"])
    await until(() => readSupervisionHealth(registration), value => value.state === "absent")
    // Retry deferred/permission cleanup only after the sandbox process has ended.
    await control("retry")
    result.resources = await scope.adapter.observe()
    assert.equal((result.resources as { resources: string }).resources, "absent")
    assert.equal((result.resources as { guard: string }).guard, "absent")
    result.linger = await linuxCommand("/usr/bin/loginctl", ["show-user", String(process.getuid!()), "--property=Linger", "--value"])
  } else if (phase === "lock") {
    let collision = false
    await withLinuxSupervisionLock(path.join(store.directory, "admission.lock"), async () => {
      try { await withLinuxSupervisionLock(path.join(store.directory, "admission.lock"), async () => {}) }
      catch { collision = true }
    })
    assert.ok(collision)
    await withLinuxSupervisionLock(path.join(store.directory, "admission.lock"), async () => {})
    const holder = spawn(process.execPath, [process.argv[1]!, "lock-hold", root], { stdio: ["ignore", "pipe", "ignore"] })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("holder-deadline")), 15_000)
      holder.stdout.once("data", bytes => { clearTimeout(timer); bytes.toString().includes("locked") ? resolve() : reject(new Error()) })
      holder.once("error", reject)
    })
    holder.kill("SIGKILL")
    await new Promise(resolve => holder.once("close", resolve))
    await until(async () => {
      try { await withLinuxSupervisionLock(path.join(store.directory, "admission.lock"), async () => {}); return true }
      catch { return false }
    }, value => value)
    result.lock = "exclusive; normal release; holder crash releases native flock"
  } else if (phase === "lock-hold") {
    await withLinuxSupervisionLock(path.join(store.directory, "admission.lock"), async () => {
      console.log("locked")
      await delay(60_000)
    })
  } else throw new Error("unknown phase")
  console.log(JSON.stringify(result))
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : "linux-qualification-failed"); process.exitCode = 1 })
