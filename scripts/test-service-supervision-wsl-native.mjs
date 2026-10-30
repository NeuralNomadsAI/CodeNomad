// node --import tsx scripts/test-service-supervision-wsl-native.mjs OUTPUT_DIRECTORY
// Ubuntu only. All owned roots/tasks/processes are unique and disposable;
// distribution lifetime stays under the user's control.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID, createHash } from "node:crypto"
import { mkdir, lstat, readFile, stat, writeFile, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:net"
import { setTimeout } from "node:timers/promises"
import { acquireWslSupervision } from "../packages/server/src/host-lifetime/service-supervision-wsl-resolver.ts"
import { readWslSupervisionSample, runSupervisionWsl, wslSupervisionLookup, wslSupervisionLaunch } from "../packages/server/src/host-lifetime/service-supervision-wsl.ts"
import { readWindowsSupervisionRuntime } from "../packages/server/src/host-lifetime/service-supervision-windows.ts"
import { windowsStorageScript, verifyWindowsStorageEvidence } from "../packages/server/src/host-lifetime/windows-storage.ts"

assert.equal(process.platform, "win32")
const output = process.argv[2]
assert.ok(output && path.isAbsolute(output))
await mkdir(output, { recursive: true })
const exec = promisify(execFile), id = randomUUID()
const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")
const quote = value => `'${value.replaceAll("'", "''")}'`
const ps = async script => (await exec(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + script, "utf16le").toString("base64")],
{ windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
  env: { ...process.env, PSModulePath: path.join(path.dirname(powershell), "Modules") } })).stdout.trim()
const bridge = { executable: path.join(process.env.SystemRoot, "System32/wsl.exe"), distro: "Ubuntu", account: "pascal" }
const linux = `/home/pascal/codenomad supervision wsl-${id}`
const binary = `${linux}/bin/opencode`
const shared = path.join(os.homedir(), ".local/state/opencode/service.json")
const fingerprint = async () => ({ sha256: createHash("sha256").update(await readFile(shared)).digest("hex"), mtime: (await stat(shared)).mtime.toISOString() })
const result = { checks: [], sharedBefore: await fingerprint(), linux, timings: {} }
// Keep copied executable paths within CreateProcessW's ordinary executable-path
// bound. Detailed evidence remains in the caller's longer scratch directory.
const root = path.join(os.tmpdir(), "opencode", `wsl-${id}`)
await mkdir(path.dirname(root), { recursive: true })
result.windowsRoot = root
let acquired, runtime, health, names = [], serviceConfigured = false
async function until(read, predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout
  let value
  do { value = await read(); if (predicate(value)) return value; await setTimeout(500) } while (Date.now() < deadline)
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
try {
  // Only this explicitly acquired distro is started. docker-desktop is untouched.
  assert.equal(await runSupervisionWsl(bridge, ["/usr/bin/id", "-u"]), "1000")
  await runSupervisionWsl(bridge, ["/bin/sh", "-c",
    'set -eu; test ! -e "$1"; umask 077; mkdir -p "$1/bin" "$1/home" "$1/config/opencode" "$1/state/opencode" "$1/data/opencode" "$1/cache/opencode"; curl -fsSL --max-time 90 -o "$1/bin/archive.tgz" https://github.com/anomalyco/opencode/releases/download/v2.2.1/opencode-linux-x64.tar.gz; tar -xzf "$1/bin/archive.tgz" -C "$1/bin"; rm "$1/bin/archive.tgz"', "fixture-setup", linux], 100000)
  const nativeEnvironment = { HOME: `${linux}/home`, XDG_CONFIG_HOME: `${linux}/config`, XDG_STATE_HOME: `${linux}/state`,
    XDG_DATA_HOME: `${linux}/data`, XDG_CACHE_HOME: `${linux}/cache` }
  const service = args => runSupervisionWsl(bridge, ["/usr/bin/env", "-i", ...Object.entries(nativeEnvironment).map(([k, v]) => `${k}=${v}`),
    "PATH=/usr/bin:/bin", binary, ...args], 30000)
  assert.match(await service(["--version"]), /^(?:opencode v)?2\.2\.1$/)
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  assert.notEqual(port, 28894)
  await service(["service", "set", "port", String(port)])
  serviceConfigured = true
  // Same private-leaf qualification policy as the Windows native test. Production
  // retains the stricter complete ancestor/owner/DACL admission policy.
  const policy = { async verify(file, directory) {
    const s = await lstat(file)
    assert.ok(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile() && s.nlink === 1))
    const { script } = windowsStorageScript(file)
    const evidence = JSON.parse(await ps(script)); evidence.entries = evidence.entries.slice(0, 1)
    verifyWindowsStorageEvidence(JSON.stringify(evidence), directory, 0, 256 * 1024 * 1024)
  } }
  acquired = await acquireWslSupervision({ selectedBinary: () => `\\\\wsl.localhost\\Ubuntu${binary.replaceAll("/", "\\")}`,
    root, nativeEnvironment, policy, artifactPolicy: policy })
  const { store, adapter } = acquired
  runtime = await readWindowsSupervisionRuntime(store, policy)
  const key = (await store.read()).key
  const alias = await acquireWslSupervision({ selectedBinary: () => `\\\\wsl$\\ubuntu${binary.replaceAll("/", "\\")}`,
    root, nativeEnvironment, policy, artifactPolicy: policy })
  assert.equal((await alias.store.read()).key, key)
  result.checks.push("UNC aliases/distro case share canonical UID/roots/service key; real Linux executable and roots contain spaces")
  names = ["Main", "Recovery"].map(kind => `CodeNomad-OpenCode-${key}-${kind}`)
  const control = async action => {
    const request = { requestID: randomUUID(), action, expectedRevision: (await store.read()).revision }
    return until(() => store.control(request).catch(error => { if (error.code !== "busy") throw error; return null }), Boolean, "control admission", 20000)
  }
  const sample = () => store.read().then(manifest => readWslSupervisionSample(manifest, runtime.wsl))
  const lookup = wslSupervisionLookup(runtime.wsl)
  assert.equal((await sample()).health.state, "absent")
  assert.equal((await sample()).permitted, true)
  const staleOn = await control("on")
  const lockModule = new URL("../packages/server/src/host-lifetime/service-supervision-wsl-lock.ts", import.meta.url).href
  const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { mutateWslSupervisionFile } from ${JSON.stringify(lockModule)};
      await mutateWslSupervisionFile(${JSON.stringify(runtime.wsl)}, async () => {
        process.stdout.write('READY'); process.stdin.resume(); await new Promise(() => {});
      });`], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  const holderExit = new Promise(resolve => holder.once("exit", resolve))
  const offRequest = { requestID: randomUUID(), action: "off", expectedRevision: staleOn.revision }
  try {
    await new Promise((resolve, reject) => { holder.once("error", reject); holder.stdout.once("data", data => {
      assert.equal(String(data), "READY"); resolve()
    }); holder.once("exit", () => reject(new Error("Linux lock holder exited before READY"))) })
    await assert.rejects(store.control(offRequest), error => error.code === "busy")
    assert.equal((await store.read()).desired, "on")
  } finally { holder.kill(); await holderExit }
  const fenced = await until(() => store.control(offRequest).catch(error => { if (error.code !== "busy") throw error; return null }), Boolean, "released native lock")
  await adapter.reconcile(fenced.revision)
  await exec(runtime.wsl.executable, wslSupervisionLaunch(runtime.wsl, binary, staleOn.revision), { windowsHide: true, timeout: 10000, maxBuffer: 4096 })
  assert.equal((await sample()).health.state, "absent")
  result.checks.push("Linux fork lock excludes OFF, survives caller crash without stale ownership, and an old ON bridge cannot spawn after OFF")
  const on = await control("on")
  await exec(runtime.wsl.executable, wslSupervisionLaunch(runtime.wsl, binary, staleOn.revision), { windowsHide: true, timeout: 10000, maxBuffer: 4096 })
  assert.equal((await sample()).health.state, "absent")
  const probeStarted = Date.now()
  const bundledSample = JSON.parse((await exec(runtime.node, [runtime.probe, store.directory, key],
    { env: runtime.environment, windowsHide: true, timeout: 10000, maxBuffer: 32768 })).stdout)
  assert.equal(bundledSample.permitted, true)
  result.timings.bundledAbsentProbeMs = Date.now() - probeStarted
   const coldAt = Date.now()
  await adapter.reconcile(on.revision)
   const cold = await until(() => adapter.observe(), o => o.guard === "active" && o.health.state === "healthy", "foreground service")
  health = cold.health
   result.timings.distroHealthyMs = Date.now() - coldAt
  const status = JSON.parse(await readFile(path.join(store.directory, "windows-status.json"), "utf8"))
  const lineage = await runSupervisionWsl(bridge, ["/bin/sh", "-c", 'cat "/proc/$1/cmdline"; printf "\\n"; grep -E "^(PPid|SigIgn):" "/proc/$1/status"', "lineage", String(health.pid)])
  assert.match(lineage, /serve\x00--service/)
  assert.match(lineage, /SigIgn:\s+[a-f0-9]*[13579bdf]\b/)
  assert.equal(status.mode, "hosted")
  assert.ok(status.childWindowsPid > 0)
  const windowsChild = JSON.parse(await ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${status.childWindowsPid}';
    @{pid=$p.ProcessId;parent=$p.ParentProcessId;name=$p.Name;exec=($p.CommandLine.Contains('--exec /bin/sh'))}|ConvertTo-Json -Compress`))
  assert.equal(windowsChild.parent, status.guardPid)
  assert.equal(windowsChild.name.toLowerCase(), "wsl.exe")
  assert.equal(windowsChild.exec, true)
  result.foreground = { linuxPID: health.pid, guardPID: status.guardPid, windowsChild, lineage }
   result.checks.push("ON starts foreground managed service; authenticated Windows forwarding + exact Linux UID/PID/start/id; SIGHUP ignored; distro lifetime preserved")
  const unreachable = await readWslSupervisionSample(await store.read(), runtime.wsl, async () => undefined)
  assert.equal(unreachable.health.state, "unhealthy")
  assert.equal(unreachable.forwardingUnavailable, true)
  assert.deepEqual((await sample()).health, health)
  result.checks.push("injected Windows discovery refusal + real healthy Linux CLI status distinguish forwarding failure without changing the service")
  const xml = await ps(`Export-ScheduledTask -TaskName '${names[1]}'`)
  assert.match(xml, /<MultipleInstancesPolicy>Queue</)
  assert.match(xml, /<ExecutionTimeLimit>PT10S</)
  assert.match(xml, /<Interval>PT1M</)
  assert.doesNotMatch(xml, /password|(?:TOKEN|API_KEY)\s*=/i)
  assert.equal(xml.includes(await service(["service", "get", "password"])), false)
  result.checks.push("shared Windows Recovery policy: Queue, independent 60 s tick, ten-second deadline, no secrets")
  // Real health loss: preserve the live managed child, then recover same identity.
  await runSupervisionWsl(bridge, ["/bin/kill", "-STOP", String(health.pid)])
  try {
    await setTimeout(8000)
    assert.notEqual((await sample()).health.state, "healthy")
    assert.equal((await lookup(health.pid)).startIdentity, health.startIdentity)
  } finally { await runSupervisionWsl(bridge, ["/bin/kill", "-CONT", String(health.pid)]) }
  assert.deepEqual((await until(sample, s => s.health.state === "healthy", "health recovered")).health, health)
  result.checks.push("live unhealthy Linux child is retained; SIGCONT restores identical PID/id/start")
  // Compound guard/action fault: restore artifact, then rely solely on OS ticks.
  const script = runtime.script
  await rename(script, script + ".unavailable")
  try {
    await ps(`Stop-Process -Id ${status.guardPid} -Force`)
    await setTimeout(12000)
    const failing = await adapter.observe()
    assert.equal(failing.artifactMissing, true)
    assert.ok(failing.recoveryNextTickAt)
    assert.deepEqual(failing.health, health)
  } finally { await rename(script + ".unavailable", script) }
  const restoredAt = Date.now()
  await until(() => adapter.observe(), o => o.guard === "active" && o.health.state === "healthy", "OS backstop", 90000)
  assert.deepEqual((await sample()).health, health)
  result.timings.guardRecoveredAfterArtifactRestoreMs = Date.now() - restoredAt
  result.checks.push("guard death + missing action retain ON/OS next tick; independent Recovery repairs Main after restoration and adopts unchanged service")
  const off = await control("off")
  await adapter.reconcile(off.revision)
  assert.equal((await adapter.observe()).resources, "absent")
  const clients = () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='wsl.exe'"|Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${quote(linux)}) }).Count`)
  await until(clients, count => count === "0", "foreground WSL clients released", 15000)
  // No WSL inspection/client is launched during this idle interval.
  await setTimeout(75000)
  assert.deepEqual((await sample()).health, health)
  result.checks.push("OFF removes tasks/releases Windows and Linux bridges; service survives 75 s without run-owned Windows clients")
  const on2 = await control("on"); await adapter.reconcile(on2.revision)
  const adopted = await until(() => adapter.observe(), o => o.guard === "active" && o.health.state === "healthy", "readopt")
  assert.deepEqual(adopted.health, health)
  await runSupervisionWsl(bridge, ["/bin/kill", "-STOP", String(health.pid)])
  try {
    await setTimeout(8000)
    assert.notEqual((await sample()).health.state, "healthy")
    assert.equal((await lookup(health.pid)).startIdentity, health.startIdentity)
  } finally { await runSupervisionWsl(bridge, ["/bin/kill", "-CONT", String(health.pid)]) }
  assert.deepEqual((await until(sample, s => s.health.state === "healthy", "incumbent health recovered")).health, health)
  result.checks.push("adopted incumbent survives real health loss and recovers with identical PID/id/start")
  const crashAt = Date.now()
  await runSupervisionWsl(bridge, ["/bin/kill", "-KILL", String(health.pid)])
  const restarted = await until(() => adapter.observe(), o => o.health.state === "healthy" && o.health.id !== health.id, "crash recovery")
  health = restarted.health
  result.timings.serviceHealthyAfterCrashMs = Date.now() - crashAt
  result.checks.push("ON re-adopts preserved identity; real Linux service crash starts one new healthy incarnation")
  await service(["service", "stop"])
  const stopped = await until(() => adapter.observe(), o => o.health.state === "healthy" && o.health.id !== health.id, "stop under ON")
  health = stopped.health
  await service(["service", "restart"])
  health = (await until(sample, s => s.health.state === "healthy", "CLI restart")).health
  await setTimeout(6000)
  assert.deepEqual((await sample()).health, health)
  result.checks.push("native stop under ON recovers; CLI restart incumbent is adopted without replacement")
  await service(["service", "set", "disabled", "true"])
  await setTimeout(8000)
  assert.equal((await sample()).health.state, "absent")
  assert.equal((await sample()).permitted, false)
  const finalOff = await control("off"); await adapter.reconcile(finalOff.revision)
  await service(["service", "unset", "disabled"])
  await setTimeout(3000)
  assert.equal((await sample()).health.state, "absent")
  result.checks.push("native disabled blocks spawn; OFF stays OFF after native re-enable")
  result.passed = true
} catch (error) {
  result.failure = { message: error.message, stack: error.stack }
  await writeFile(path.join(output, "failure.json"), JSON.stringify(result, null, 2))
  throw error
} finally {
  if (acquired) {
    const { store, adapter } = acquired
    const manifest = await store.read()
    if (manifest.desired !== "off") await store.control({ requestID: randomUUID(), action: "off", expectedRevision: manifest.revision })
    await adapter.reconcile((await store.read()).revision)
    assert.equal(await ps(`@(${names.map(name => `Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue`).join(";")}).Count`), "0")
  }
  if (serviceConfigured) {
    await runSupervisionWsl(bridge, ["/usr/bin/env", "-i", `HOME=${linux}/home`, `XDG_CONFIG_HOME=${linux}/config`, `XDG_STATE_HOME=${linux}/state`,
      `XDG_DATA_HOME=${linux}/data`, `XDG_CACHE_HOME=${linux}/cache`, "PATH=/usr/bin:/bin", binary, "service", "stop"], 30000)
    if (health) await until(() => wslSupervisionLookup(runtime.wsl)(health.pid), p => p.state === "dead", "cleanup Linux exit")
  }
  // The only recursive deletion is this run's freshly created exact UUID root.
  await runSupervisionWsl(bridge, ["/bin/rm", "-rf", "--", linux])
  result.sharedAfter = await fingerprint()
  assert.deepEqual(result.sharedAfter, result.sharedBefore)
  result.distros = (await exec(bridge.executable, ["--list", "--verbose"], { encoding: "utf16le", timeout: 30000 })).stdout.trim()
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  result.cleaned = true
  await writeFile(path.join(output, "results.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
