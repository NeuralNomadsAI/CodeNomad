// node --import tsx scripts/test-service-supervision-windows-native.mjs ABSOLUTE_CLI
// Builds must already have produced the owned guard/probe artifacts. All tasks,
// processes, service roots and descriptor paths belong to this unique run.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, stat, lstat, rm, rename } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:net"
import { setTimeout } from "node:timers/promises"
import { supervisionStatus } from "../packages/server/src/host-lifetime/service-supervision-contract.ts"
import { readSupervisionHealth } from "../packages/server/src/host-lifetime/service-supervision-health.ts"
import { ServiceSupervisionSettings } from "../packages/server/src/host-lifetime/service-supervision-service.ts"
import { lookupProcess } from "../packages/server/src/host-lifetime/process-identity.ts"
import { windowsStorageScript, verifyWindowsStorageEvidence } from "../packages/server/src/host-lifetime/windows-storage.ts"
import { acquireWindowsSupervision } from "../packages/server/src/host-lifetime/service-supervision-resolver.ts"
import { provisionSupervisionRuntime } from "../packages/server/src/host-lifetime/service-supervision-runtime.ts"
import { registerServiceSupervisionRoutes } from "../packages/server/src/server/routes/service-supervision.ts"
import { AuthManager } from "../packages/server/src/auth/manager.ts"
import Fastify from "fastify"

assert.equal(process.platform, "win32")
const binary = process.argv[2]
assert.ok(binary && path.isAbsolute(binary))
const exec = promisify(execFile)
const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")
const ps = async script => (await exec(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + script, "utf16le").toString("base64")],
{ windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
  env: { ...process.env, PSModulePath: path.join(path.dirname(powershell), "Modules") } })).stdout.trim()
const shared = path.join(os.homedir(), ".local/state/opencode/service.json")
const fingerprint = async () => ({ sha256: createHash("sha256").update(await readFile(shared)).digest("hex"),
  LastWriteTimeUtc: (await stat(shared)).mtime.toISOString() })
const before = await fingerprint()
const temp = path.join(os.tmpdir(), "opencode")
await mkdir(temp, { recursive: true })
const root = await mkdtemp(path.join(temp, "supervision windows "))
let serviceMayExist = false
try {
const quote = value => `'${value.replace(/'/g, "''")}'`
const sid = await ps("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value")
await ps(`$user=[Security.Principal.SecurityIdentifier]::new('${sid}'); $acl=[Security.AccessControl.DirectorySecurity]::new();
  $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false);
  foreach ($s in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  }; Set-Acl -LiteralPath ${quote(root)} -AclObject $acl`)
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
  COMSPEC: path.join(process.env.SystemRoot, "System32/cmd.exe") }
for (const [key, name] of Object.entries({ HOME: "home", USERPROFILE: "home", OPENCODE_TEST_HOME: "home",
  APPDATA: "appdata", LOCALAPPDATA: "localappdata", XDG_CONFIG_HOME: "config", XDG_STATE_HOME: "state",
  XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", TEMP: "tmp", TMP: "tmp" })) {
  env[key] = path.join(root, name)
  await mkdir(env[key], { recursive: true })
}
const service = args => exec(binary, args, { cwd: root, env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })
const reservation = createServer()
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
assert.notEqual(port, 28894)
await service(["service", "set", "port", String(port)])
const namespace = { platform: "win32", host: os.hostname(), user: sid,
  configDirectory: path.join(env.XDG_CONFIG_HOME, "opencode"), stateDirectory: path.join(env.XDG_STATE_HOME, "opencode"),
  registrationName: "service.json" }
// This host's existing ancestor DACL is refused by the production policy. Only
// the run-owned private leaf DACL is evaluated here; no existing ACL is changed.
const policy = { async verify(file, directory) {
  const s = await lstat(file)
  assert.ok(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile() && s.nlink === 1))
  const { script } = windowsStorageScript(file)
  const evidence = JSON.parse(await ps(script))
  evidence.entries = evidence.entries.slice(0, 1)
   verifyWindowsStorageEvidence(JSON.stringify(evidence), directory, 0, 256 * 1024 * 1024)
} }
const acquire = () => acquireWindowsSupervision({ selectedBinary: () => binary, environment: env, root, policy, artifactPolicy: policy })
const { store, adapter } = await acquire()
const { script } = await provisionSupervisionRuntime(store.directory, policy)
const registration = path.join(namespace.stateDirectory, "service.json")
const key = (await store.read()).key
const settings = new ServiceSupervisionSettings(acquire)
const app = Fastify({ logger: false })
const logger = { child() { return this }, info() {}, warn() {}, error() {}, debug() {} }
const auth = new AuthManager({ configPath: path.join(root, "settings/config.yaml"), username: "fixture", password: randomUUID(), generateToken: false }, logger)
const cookie = `${auth.getCookieName()}=${auth.createSession("fixture").id}`
registerServiceSupervisionRoutes(app, { service: settings, auth })
assert.equal((await app.inject({ method: "GET", url: "/api/opencode/supervision" })).statusCode, 401)
const settingsControl = async action => {
  const response = await app.inject({ method: "POST", url: "/api/opencode/supervision", headers: { cookie },
    payload: { serviceKey: key, requestID: randomUUID(), expectedRevision: (await store.read()).revision, action } })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
const names = ["Main", "Recovery"].map(kind => `CodeNomad-OpenCode-${key}-${kind}`)
const control = async action => {
  const m = await store.read()
  const request = { requestID: randomUUID(), expectedRevision: m.revision, action }
  // Native actors may briefly own the admission handle. The fixture explicitly
  // retries only this exact control identity, never a changed revision/request.
  const deadline = Date.now() + 15000
  for (;;) {
    try { return await store.control(request) }
    catch (error) { if (error.code !== "busy" || Date.now() >= deadline) throw error; await setTimeout(200) }
  }
}
async function until(read, predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await setTimeout(500)
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
const result = { platform: "win32", root, port, tasks: names, sharedBefore: before, checks: [], timings: {} }
let lastHealth
const suspension = async (health, resume) => {
  assert.equal((await lookupProcess(health.pid)).startIdentity, health.startIdentity)
  await ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PauseNative {
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
    [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h); }';
    $h=[PauseNative]::OpenProcess(0x800,$false,${health.pid}); if ($h -eq [IntPtr]::Zero) { throw 'open' };
    try { if ([PauseNative]::${resume ? "NtResumeProcess" : "NtSuspendProcess"}($h) -ne 0) { throw 'signal' } } finally { [void][PauseNative]::CloseHandle($h) }`)
}
try {
  const initialOff = await control("off")
  await adapter.reconcile(initialOff.revision)
  assert.equal((await adapter.observe()).resources, "absent")
  assert.equal((await readSupervisionHealth(registration)).state, "absent")
  result.checks.push("explicit OFF in a fresh namespace acknowledges absence without starting service")
  const foreignMarker = `isolated foreign task ${randomUUID()}`
  await ps(`$principal=New-ScheduledTaskPrincipal -UserId '${sid}' -LogonType Interactive -RunLevel Limited;
    Register-ScheduledTask -TaskName '${names[0]}' -TaskPath '\\' -Principal $principal -Description '${foreignMarker}' -Action (New-ScheduledTaskAction -Execute ${quote(powershell)} -Argument '-NoProfile -Command exit')|Out-Null`)
  try {
    const refused = await control("on")
    await assert.rejects(adapter.reconcile(refused.revision), /busy/)
    assert.equal(await ps(`(Get-ScheduledTask -TaskName '${names[0]}').Description`), foreignMarker)
    assert.equal((await readSupervisionHealth(registration)).state, "absent")
  } finally {
    await ps(`$t=Get-ScheduledTask -TaskName '${names[0]}' -ErrorAction SilentlyContinue;
      if ($t) { if ($t.Description -ne '${foreignMarker}') { throw 'ownership-changed' }; Unregister-ScheduledTask -InputObject $t -Confirm:$false }`)
  }
  const reset = await control("off")
  await adapter.reconcile(reset.revision)
  result.checks.push("foreign homonymous Main is refused and preserved; no service or Recovery installed")
  // Incumbent before ON: installing must adopt the exact existing incarnation.
  serviceMayExist = true
  await service(["service", "start"])
  const incumbent = await readSupervisionHealth(registration)
  assert.equal(incumbent.state, "healthy")
  lastHealth = incumbent
   await settingsControl("on")
  const running = await until(() => adapter.observe(), o => o.guard === "active" && o.health.state === "healthy", "adopt incumbent")
  assert.deepEqual(running.health, incumbent)
   assert.equal(supervisionStatus(await store.read(), running).state, "running")
   const settingsRead = await settings.read({ serviceKey: key })
   assert.equal(settingsRead.state, "running")
   assert.doesNotMatch(JSON.stringify(settingsRead), /configDirectory|stateDirectory|password|target/)
  result.checks.push("ON without Mission adopts incumbent unchanged; active guard + authenticated health")
  await suspension(incumbent, false)
  try {
    await setTimeout(8000)
    const unresponsive = await adapter.observe()
    assert.notEqual(unresponsive.health.state, "healthy")
    assert.equal((await lookupProcess(incumbent.pid)).startIdentity, incumbent.startIdentity)
  } finally { await suspension(incumbent, true) }
  const incumbentRecovered = await until(() => adapter.observe(), o => o.health.state === "healthy", "incumbent health recovery")
  assert.deepEqual(incumbentRecovered.health, incumbent)
  result.checks.push("real incumbent suspended across health timeouts: unchanged PID/id recovers without kill/respawn")
  // Generated task policy, independent persistent triggers, battery behavior.
  const xml = await ps(`ConvertTo-Json -InputObject @(${names.map(name => `(Export-ScheduledTask -TaskName '${name}' -TaskPath '\\')`).join(",")}) -Compress`)
  const [mainXML, recoveryXML] = JSON.parse(xml)
  assert.match(mainXML, /<MultipleInstancesPolicy>IgnoreNew</)
  assert.match(mainXML, /<ExecutionTimeLimit>PT0S</)
  assert.match(recoveryXML, /<MultipleInstancesPolicy>Queue</)
  assert.match(recoveryXML, /<ExecutionTimeLimit>PT10S</)
  assert.match(recoveryXML, /<Interval>PT1M</)
  assert.match(recoveryXML, /<EventTrigger>/)
  assert.match(recoveryXML, /<LogonTrigger>/)
  assert.match(mainXML, /<DisallowStartIfOnBatteries>false</)
  result.checks.push("Main IgnoreNew foreground; Recovery Queue event/logon/60 s, 10 s deadline, battery enabled")
  // Compound fault: no new Main failure event can repair an absent action. The
  // independent OS tick must retain its obligation and retry after restoration.
  const guard = JSON.parse(await readFile(path.join(store.directory, "windows-status.json"), "utf8"))
  assert.equal((await lookupProcess(guard.guardPid)).startIdentity, guard.guardStart)
  const priorRecovery = await ps(`(Get-ScheduledTaskInfo -TaskName '${names[1]}').LastRunTime.Ticks.ToString()`)
  await rename(script, script + ".unavailable")
  let artifactRestoredAt
  try {
    await ps(`Stop-Process -Id ${guard.guardPid} -Force`)
    await until(async () => JSON.parse(await ps(`$i=Get-ScheduledTaskInfo -TaskName '${names[1]}';
      @{result=$i.LastTaskResult;ran=($i.LastRunTime.Ticks.ToString() -ne '${priorRecovery}')}|ConvertTo-Json -Compress`)),
      value => value.ran && ![0, 267009, 267011].includes(value.result), "Recovery fails while artifact is absent", 80000)
   assert.deepEqual(await readSupervisionHealth(registration), incumbent)
    const diagnostic = await app.inject({ method: "GET", url: "/api/opencode/supervision", headers: { cookie } })
    assert.equal(diagnostic.statusCode, 200, diagnostic.body)
    assert.equal(diagnostic.json().state, "failing")
    assert.equal(diagnostic.json().cause, "artifact-missing")
    assert.ok(diagnostic.json().recoveryNextTickAt)
    assert.equal(diagnostic.json().serviceResponding, true)
    result.checks.push("authenticated route retains ON, artifact-missing and the OS next Recovery tick with guard/action absent")
  } finally { await rename(script + ".unavailable", script); artifactRestoredAt = Date.now() }
  const recoveredGuard = await until(async () => {
    const o = await adapter.observe()
    const s = JSON.parse(await readFile(path.join(store.directory, "windows-status.json"), "utf8"))
    return { o, s }
  }, value => value.o.guard === "active" && value.s.guardPid !== guard.guardPid, "backstop repairs missing guard", 80000)
  assert.deepEqual(recoveredGuard.o.health, incumbent)
  result.timings.guardHealthyObservedAfterArtifactRestoredMs = Date.now() - artifactRestoredAt
  result.checks.push("real guard loss + absent script: independent 60 s backstop recovers after artifact restoration, incumbent unchanged")
  // OFF release and re-adoption: exact PID/id/start identity, not just HTTP 200.
   const off = await settingsControl("off")
   assert.equal(off.state, "off")
   assert.equal(off.serviceResponding, true)
   await settings.firstPlay({ serviceKey: key, requestID: randomUUID() }, () => {})
   assert.equal((await store.read()).desired, "off")
  assert.deepEqual(await readSupervisionHealth(registration), incumbent)
  const observation = await adapter.observe()
  assert.equal(observation.resources, "absent")
  assert.equal(observation.guard, "absent")
  const on2 = await control("on")
  await adapter.reconcile(on2.revision)
  const adopted = await until(() => adapter.observe(), o => o.guard === "active" && o.health.state === "healthy", "readopt")
  assert.deepEqual(adopted.health, incumbent)
  result.checks.push("OFF removes both tasks without stopping service; ON readopts identical PID/id/start")
  // Own child after crash: guard must remain resident, then restart the service.
  const crashAt = Date.now()
  await ps(`Stop-Process -Id ${incumbent.pid} -Force`)
  const restarted = await until(() => adapter.observe(), o => o.health.state === "healthy" && o.health.id !== incumbent.id, "crash recovery")
  lastHealth = restarted.health
  result.timings.serviceHealthyObservedAfterKillMs = Date.now() - crashAt
  const hostingGuard = JSON.parse(await readFile(path.join(store.directory, "windows-status.json"), "utf8"))
  const lineage = JSON.parse(await ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${restarted.health.pid}';
    @{pid=$p.ProcessId;parent=$p.ParentProcessId;foreground=($p.CommandLine -match 'serve --service')}|ConvertTo-Json -Compress`))
  assert.equal(lineage.parent, hostingGuard.guardPid)
  assert.equal(lineage.foreground, true)
  result.foregroundLineage = lineage
  result.checks.push("real isolated incumbent crash recovers to new healthy incarnation")
  await suspension(restarted.health, false)
  try {
    await setTimeout(8000)
    const unresponsive = await adapter.observe()
    assert.notEqual(unresponsive.health.state, "healthy")
    assert.notEqual(supervisionStatus(await store.read(), unresponsive).state, "running")
    assert.equal((await lookupProcess(restarted.health.pid)).startIdentity, restarted.health.startIdentity)
  } finally { await suspension(restarted.health, true) }
  const recovered = await until(() => adapter.observe(), o => o.health.state === "healthy", "health recovery")
  assert.deepEqual(recovered.health, restarted.health)
  result.checks.push("real hosted PID suspended across health timeouts: no kill/respawn; same PID/id recovers after resume")
  // OFF for a genuinely hosted child exercises the native PowerShell boundary.
  const off2 = await control("off")
  await adapter.reconcile(off2.revision)
  assert.deepEqual(await readSupervisionHealth(registration), restarted.health)
  await service(["service", "stop"])
  await until(() => lookupProcess(restarted.health.pid), p => p.state === "dead", "hosted child exit")
  await setTimeout(2000)
  assert.equal((await readSupervisionHealth(registration)).state, "absent")
  result.checks.push("OFF releases hosted foreground child unchanged; explicit stop stays stopped")
  const on3 = await control("on")
  await adapter.reconcile(on3.revision)
  const cold = await until(() => adapter.observe(), o => o.health.state === "healthy", "ON from stopped")
  lastHealth = cold.health
  await service(["service", "stop"])
  const stoppedRecovery = await until(() => adapter.observe(), o => o.health.state === "healthy" && o.health.id !== cold.health.id, "stop under ON")
  lastHealth = stoppedRecovery.health
  await service(["service", "restart"])
  const cliRestart = await readSupervisionHealth(registration)
  assert.equal(cliRestart.state, "healthy")
  lastHealth = cliRestart
  await setTimeout(6000)
  assert.deepEqual(await readSupervisionHealth(registration), cliRestart)
  result.checks.push("ON from stopped starts foreground; native stop recovers; native restart incarnation is adopted without another replacement")
  await service(["service", "set", "disabled", "true"])
  await until(() => lookupProcess(cliRestart.pid), p => p.state === "dead", "native disabled stops service")
   await setTimeout(8000)
   assert.equal((await readSupervisionHealth(registration)).state, "absent")
   const disabled = await settings.read({ serviceKey: key })
   assert.equal(disabled.state, "failing")
   assert.equal(disabled.cause, "native-service-disabled-or-unknown")
  await service(["service", "unset", "disabled"])
  const enabled = await until(() => adapter.observe(), o => o.health.state === "healthy", "native disabled cleared")
  lastHealth = enabled.health
  result.checks.push("native service disabled blocks new spawns under ON; clearing it allows guarded recovery")
  result.passed = true
} finally {
  await rename(script + ".unavailable", script).catch(error => { if (error.code !== "ENOENT") throw error })
  result.guardStatus = await readFile(path.join(store.directory, "windows-status.json"), "utf8").then(JSON.parse).catch(() => null)
  result.taskResults = await ps(`ConvertTo-Json -InputObject @(${names.map(name => `(Get-ScheduledTaskInfo -TaskName '${name}' -ErrorAction SilentlyContinue|Select-Object LastTaskResult)`).join(",")}) -Compress`).then(JSON.parse).catch(() => null)
  try {
    const m = await store.read()
    const off = m.desired === "off" ? m : await control("off")
    await adapter.reconcile(off.revision)
  } catch {
    // Failure cleanup is scoped to exact unique names and ownership marker.
    // End is permitted only for this disposable test, never the product OFF.
    await ps(`foreach ($name in @(${names.map(quote).join(",")})) {
      $t=Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue
      if ($t) { if ($t.Description -ne ${quote(`CodeNomad OpenCode supervision v1 key=${key} root=${store.directory}`)}) { throw 'foreign' }
        Disable-ScheduledTask -InputObject $t|Out-Null; Stop-ScheduledTask -InputObject $t; Unregister-ScheduledTask -InputObject $t -Confirm:$false }
    }`)
  }
  await service(["service", "stop"])
  if (lastHealth?.state === "healthy") await until(() => lookupProcess(lastHealth.pid), p => p.state === "dead", "final service exit")
  assert.equal((await readSupervisionHealth(registration)).state, "absent")
  const remaining = await ps(`@(${names.map(name => `Get-ScheduledTask -TaskName '${name}' -TaskPath '\\' -ErrorAction SilentlyContinue`).join(";")}).Count`)
  assert.equal(remaining, "0")
  await until(async () => Number(await ps(`@(Get-CimInstance Win32_Process|Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains(${quote(root)})
  }).Count`)), count => count === 0, "all run-owned wrappers/probes exited", 15000)
  result.sharedAfter = await fingerprint()
  assert.deepEqual(result.sharedAfter, before)
   serviceMayExist = false
   await app.close()
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  result.cleaned = true
  console.log(JSON.stringify(result, null, 2))
}
} finally {
  // Setup failures create no live service. Failed runtime cleanup retains its
  // roots for explicit recovery instead of deleting a potentially live DB.
  if (!serviceMayExist) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
