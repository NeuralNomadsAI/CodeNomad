// Bundle beside the production guard, then run only in an isolated macOS sandbox
// with an open graphical session. Root cleanup belongs to the invoking VM harness.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import net from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { acquirePosixSupervision } from "../packages/server/src/host-lifetime/service-supervision-linux-resolver"
import { ServiceSupervisionSettings } from "../packages/server/src/host-lifetime/service-supervision-service"
import { readSupervisionHealth } from "../packages/server/src/host-lifetime/service-supervision-health"
import { lookupMacosProcess, withMacosSupervisionLock } from "../packages/server/src/host-lifetime/service-supervision-macos-native"
import { readNativeScheduleIncarnation } from "../packages/server/src/opencode/missions/native-schedule-transport-identity"

async function main() {
  const [root, mode] = process.argv.slice(2)
  assert.equal(process.platform, "darwin")
  assert.match(root!, /^\/Users\/[^/]+\/cn-host-macos-[A-Za-z0-9-]+$/)
  assert.equal((await lstat(root!)).isSymbolicLink(), false)
  const helper = path.join(root!, "native"), lookup = (pid: number) => lookupMacosProcess(pid, helper)
  if (mode === "lock-hold") {
    await withMacosSupervisionLock(path.join(root!, "lock-check"), async () => {
      console.log("locked"); await delay(60_000)
    }, undefined, helper)
    return
  }
  const binary = path.join(root!, "Open Code/opencode"), environment = { HOME: path.join(root!, "home"), PATH: "/usr/bin:/bin",
    XDG_CONFIG_HOME: path.join(root!, "config"), XDG_STATE_HOME: path.join(root!, "state"),
    XDG_DATA_HOME: path.join(root!, "data"), XDG_CACHE_HOME: path.join(root!, "cache") }
  async function run(file: string, args: string[], allowed = false) {
    return new Promise<{ code: number; text: string }>((resolve, reject) => execFile(file, args,
      { env: environment, timeout: 30_000, maxBuffer: file === "/bin/ps" ? 1024 * 1024 : 65536 }, (error, stdout) => {
        if (error && (!allowed || typeof error.code !== "number")) return reject(new Error(`sandbox-command-failed:${path.basename(file)}:${args[0]}:${error.code}`))
        resolve({ code: error ? Number(error.code) : 0, text: stdout.trim() })
      }))
  }
  const scope = await acquirePosixSupervision({ selectedBinary: () => binary, environment, root: path.join(root!, "supervision"),
    guardSource: path.join(root!, "guard.cjs"), nativeHelperSource: helper })
  const store = scope.store, settings = new ServiceSupervisionSettings(async () => scope), manifest = await store.read()
  const registration = path.join(manifest.namespace.stateDirectory, manifest.namespace.registrationName)
  const label = `org.codenomad.opencode.${manifest.key}`, target = `gui/${process.getuid!()}/${label}`
  const plist = path.join("/Users", process.env.USER!, "Library/LaunchAgents", `${label}.plist`)
  const result: Record<string, unknown> = { platform: process.platform, label, user: process.getuid!() }
  const readHealth = () => readSupervisionHealth(registration, { lookup })
  async function control(action: "on" | "off" | "retry") {
    const m = await store.read()
    return settings.control({ action, serviceKey: m.key, requestID: randomUUID(), expectedRevision: m.revision }, () => {})
  }
  async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 30_000) {
    const end = Date.now() + timeout
    let last: T | undefined
    while (Date.now() < end) { last = await read(); if (accepts(last)) return last; await delay(250) }
    throw new Error(`sandbox-deadline:${JSON.stringify(last)}`)
  }
  async function running() { return until(() => settings.read(), value => value.state === "running") }
  async function identity() {
    const health = await readHealth(); assert.equal(health.state, "healthy")
    if (health.state !== "healthy") throw new Error()
    return { ...health, hash: createHash("sha256").update(await readFile(registration)).digest("hex") }
  }
  async function agent() {
    const print = (await run("/bin/launchctl", ["print", target])).text
    const pid = Number(print.match(/^\tpid = (\d+)$/m)?.[1]), runs = Number(print.match(/^\truns = (\d+)$/m)?.[1])
    return { pid, runs }
  }
  async function contenders() {
    const rows = (await run("/bin/ps", ["-axo", "pid=,command="])).text.split("\n")
    return rows.filter(row => row.includes(`${binary} serve --service`)).map(row => Number(row.trim().split(/\s+/)[0]))
  }
  try {
    assert.equal((await run("/bin/launchctl", ["print", target], true)).code, 113)
    const reservation = net.createServer()
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve) })
    const port = (reservation.address() as net.AddressInfo).port
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    await run(binary, ["service", "set", "port", String(port)])
    result.isolatedPort = port
    const owner = await lookup(process.pid); assert.equal(owner.state, "live")
    result.nativeIdentity = owner
    // Real native lock exclusion and release after the owning Node process dies.
    await withMacosSupervisionLock(path.join(root!, "lock-check"), async () => {
      await assert.rejects(withMacosSupervisionLock(path.join(root!, "lock-check"), async () => {}, undefined, helper))
    }, undefined, helper)
    const holder = spawn(process.execPath, [process.argv[1]!, root!, "lock-hold"], { stdio: ["ignore", "pipe", "ignore"] })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { holder.kill("SIGKILL"); reject(new Error("lock-holder-deadline")) }, 10_000)
      holder.stdout.once("data", bytes => { clearTimeout(timer); bytes.toString().includes("locked") ? resolve() : reject(new Error()) })
      holder.once("error", reject)
    })
    holder.kill("SIGKILL"); await new Promise(resolve => holder.once("close", resolve))
    await until(async () => {
      try { await withMacosSupervisionLock(path.join(root!, "lock-check"), async () => {}, undefined, helper); return true } catch { return false }
    }, Boolean)
    result.nativeLock = "exclusive; caller SIGKILL releases lock without stealing"
    await control("on"); result.on = await running()
    const hosted = await identity(), guard = await agent()
    const ppid = Number((await run("/bin/ps", ["-p", String(hosted.pid), "-o", "ppid="])).text)
    assert.equal(ppid, guard.pid); assert.deepEqual(await contenders(), [hosted.pid])
    result.foreground = { hosted, guard, ppid }
    await control("on"); await running(); assert.deepEqual(await identity(), hosted)
    // A live, nonresponding child outlives any health deadline without termination.
    process.kill(hosted.pid, "SIGSTOP")
    try {
      await delay(40_000)
      assert.equal((await settings.read()).state, "failing")
      assert.equal(readNativeScheduleIncarnation(registration).id, hosted.id)
      assert.deepEqual(await contenders(), [hosted.pid])
    } finally { process.kill(hosted.pid, "SIGCONT") }
    await running(); assert.deepEqual(await identity(), hosted)
    result.hostedUnreachable40s = "same PID/id/start/registration; no second service; health recovered"
    const originalArgs = JSON.parse(await readFile(path.join(store.directory, "macos.json"), "utf8"))
    const savedGuard = `${originalArgs.guard}.saved`
    // Artifact loss remains a visible failure with ON preserved. Restitution and
    // the OS KeepAlive obligation recover without a user-level service restart.
    await rename(originalArgs.guard, savedGuard)
    try {
      assert.equal((await settings.read()).cause, "artifact-missing")
      process.kill(guard.pid, "SIGKILL")
      await delay(6000)
      assert.deepEqual(await identity(), hosted)
      assert.equal((await settings.read()).desired, "on")
    } finally { await rename(savedGuard, originalArgs.guard) }
    await running(); assert.deepEqual(await identity(), hosted)
    result.artifactRecovery = "ON unchanged; launchd recovered guard and adopted same service"
    result.off = await control("off"); assert.equal((result.off as { state: string }).state, "off")
    assert.deepEqual(await identity(), hosted)
    assert.equal((await run("/bin/launchctl", ["print", target], true)).code, 113)
    await assert.rejects(lstat(plist), { code: "ENOENT" })
    await delay(6000); assert.deepEqual(await identity(), hosted)
    await control("on"); await running(); assert.deepEqual(await identity(), hosted)
    result.offAndAdopt = await identity()
    process.kill(hosted.pid, "SIGSTOP")
    try {
      await delay(40_000)
      assert.equal((await settings.read()).state, "failing")
      assert.equal(readNativeScheduleIncarnation(registration).id, hosted.id)
      assert.deepEqual(await contenders(), [hosted.pid])
    } finally { process.kill(hosted.pid, "SIGCONT") }
    await running(); assert.deepEqual(await identity(), hosted)
    result.incumbentUnreachable40s = "same PID/id/start/registration; no second service; health recovered"
    let previous = await agent(), started = Date.now()
    process.kill(previous.pid, "SIGKILL")
    await until(agent, value => value.pid > 0 && value.pid !== previous.pid)
    await running(); assert.deepEqual(await identity(), hosted)
    result.adoptingGuardCrash = { elapsedMs: Date.now() - started, sameService: true }
    // Crash the service, then its new owning guard: both actual ownership modes.
    started = Date.now(); process.kill(hosted.pid, "SIGKILL")
    await until(readHealth, value => value.state === "healthy" && value.id !== hosted.id)
    await running(); const recovered = await identity()
    result.serviceCrash = { elapsedMs: Date.now() - started, recovered }
    previous = await agent(); started = Date.now(); process.kill(previous.pid, "SIGKILL")
    await until(agent, value => value.pid > 0 && value.pid !== previous.pid)
    await running(); assert.deepEqual(await identity(), recovered)
    result.owningGuardCrash = { elapsedMs: Date.now() - started, sameService: true }
    await run(binary, ["service", "stop"]); started = Date.now()
    await until(readHealth, value => value.state === "healthy" && value.id !== recovered.id)
    await running(); const stopped = await identity()
    result.cliStop = { elapsedMs: Date.now() - started, recovered: stopped }
    await run(binary, ["service", "restart"]); await running()
    const restarted = await identity(); await delay(6000); assert.deepEqual(await identity(), restarted)
    result.restartAdopted = restarted
    await run(binary, ["service", "set", "disabled", "true"])
    await until(() => settings.read(), value => value.cause === "native-service-disabled-or-unknown")
    await run(binary, ["service", "stop"]); await delay(6000)
    assert.equal((await readHealth()).state, "absent")
    await run(binary, ["service", "unset", "disabled"])
    await running(); result.disabledGate = await identity()
    result.finalOff = await control("off")
    const released = await identity(); await run(binary, ["service", "stop"])
    await until(readHealth, value => value.state === "absent")
    await delay(6000); assert.equal((await readHealth()).state, "absent")
    result.offNoRevival = { released, absentAfterExplicitStop: true }
    result.resources = await scope.adapter.observe()
    assert.equal((result.resources as { resources: string }).resources, "absent")
    assert.equal((result.resources as { guard: string }).guard, "absent")
    console.log("MACOS_CHECKS_PASSED " + JSON.stringify(result))
  } catch (error) {
    console.error("MACOS_CHECKPOINTS " + JSON.stringify(result))
    console.error(error instanceof Error ? error.message : "sandbox-failed")
    throw error
  } finally {
    // Sandbox-only cleanup. First release/revoke supervision, then explicitly end
    // only this isolated service. Never signal the personal installation.
    await control("off").catch(() => {})
    await run("/bin/launchctl", ["bootout", target], true).catch(() => {})
    await unlink(plist).catch(error => { if (error.code !== "ENOENT") throw error })
    await run(binary, ["service", "stop"]).catch(() => {})
    const remaining = await contenders()
    for (const pid of remaining) { process.kill(pid, "SIGCONT"); process.kill(pid, "SIGTERM") }
    await until(contenders, value => value.length === 0)
    await until(async () => (await run("/bin/launchctl", ["print", target], true)).code, value => value === 113)
    await assert.rejects(lstat(plist), { code: "ENOENT" })
    console.log("MACOS_CLEANUP_PASSED " + JSON.stringify({ label, remaining: await contenders() }))
  }
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : error.message); process.exitCode = 1 })
