// node --import tsx scripts/test-opencode-login-start-windows-native.mjs ABSOLUTE_CLI [EVIDENCE_DIRECTORY]
// Requires `npm run build:host-helpers --workspace @neuralnomads/codenomad`. Only a uniquely named task,
// an isolated OpenCode service (own HOME/XDG roots and port) and run-owned files are created; the run
// removes them and compares the shared service registration before and after.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCodeLoginStart, resolveLoginStartLaunch } from "../packages/server/src/host-lifetime/opencode-login-start.ts"
import { WindowsLoginStart, findTaskScript, psLiteral, runPowerShell } from "../packages/server/src/host-lifetime/opencode-login-start-windows.ts"
import { lookupProcess } from "../packages/server/src/host-lifetime/process-identity.ts"

assert.equal(process.platform, "win32")
const cli = process.argv[2]
assert.ok(cli && path.isAbsolute(cli), "ABSOLUTE_CLI")
const exec = promisify(execFile)
const evidence = { steps: [] }
const step = (name, value) => { evidence.steps.push({ name, ...value }); console.log(name, JSON.stringify(value)) }
const shared = path.join(os.homedir(), ".local/state/opencode/service.json")
const fingerprint = async () => ({ sha256: createHash("sha256").update(await readFile(shared)).digest("hex"),
  lastWriteTimeUtc: (await stat(shared)).mtime.toISOString() })
const before = await fingerprint()
step("shared-registration-before", before)

await mkdir(path.join(os.tmpdir(), "opencode"), { recursive: true })
const root = await mkdtemp(path.join(os.tmpdir(), "opencode", "login start native "))
const id = randomUUID(), name = `CodeNomad-OpenCode-Login-Test-${id}`, marker = `CodeNomad: start OpenCode at login (qualification ${id})`
const environment = {}
for (const [key, folder] of Object.entries({ HOME: "home", USERPROFILE: "home", OPENCODE_TEST_HOME: "home", APPDATA: "appdata",
  LOCALAPPDATA: "localappdata", XDG_CONFIG_HOME: "config", XDG_STATE_HOME: "state", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", TEMP: "tmp", TMP: "tmp" })) {
  environment[key] = path.join(root, folder)
  await mkdir(environment[key], { recursive: true })
}
const isolated = { ...process.env, ...environment }
const service = async args => (await exec(cli, args, { env: isolated, cwd: root, windowsHide: true, timeout: 30_000 })).stdout.trim()
const ps = runPowerShell
const launcherSource = fileURLToPath(new URL("../packages/server/dist/host-lifetime/opencode-login-launcher.exe", import.meta.url))
let pid
try {
  const bytes = await readFile(launcherSource), pe = bytes.readUInt32LE(0x3c)
  assert.equal(bytes.readUInt16LE(pe + 0x5c), 2, "the launcher is a GUI-subsystem image: no console is ever created for it")
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  assert.notEqual(port, 28894)
  await service(["service", "set", "port", String(port)])
  assert.equal(await service(["service", "status"]), "stopped")
  step("isolated-service", { root, port, task: name })

  const platform = new WindowsLoginStart({ name, marker, launcherSource, launcherDirectory: path.join(root, "launcher"), environment })
  const loginStart = new OpenCodeLoginStart({ platform, launch: () => resolveLoginStartLaunch(cli) })
  assert.deepEqual(await loginStart.read(), { state: "off" })
  assert.deepEqual(await loginStart.set(true), { state: "on" })
  assert.deepEqual(await loginStart.set(true), { state: "on" }, "idempotent")
  const task = JSON.parse(await ps(`$t=Get-ScheduledTask -TaskPath '\\' -TaskName ${psLiteral(name)}; $x=[xml](Export-ScheduledTask -TaskPath '\\' -TaskName ${psLiteral(name)})
$u=[string]$x.Task.Triggers.LogonTrigger.UserId; if ($u -notmatch '^S-1-') { $u=[Security.Principal.NTAccount]::new($u).Translate([Security.Principal.SecurityIdentifier]).Value }
@{ sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; triggers=@($x.Task.Triggers.ChildNodes|%{ $_.LocalName }); trigger=$u
  logon=[string]$x.Task.Principals.Principal.LogonType; level=[string]$t.Principal.RunLevel; execute=$t.Actions[0].Execute; arguments=$t.Actions[0].Arguments
  state=[string]$t.State }|ConvertTo-Json -Compress`))
  assert.deepEqual(task.triggers, ["LogonTrigger"])
  assert.equal(task.trigger, task.sid)
  assert.equal(task.logon, "InteractiveToken")
  assert.equal(task.level, "Limited", "least privilege, never elevated")
  assert.equal(task.execute, path.join(root, "launcher", "opencode-login-launcher.exe"))
  step("task-registered", task)

  // A logon runs the same action under the same principal: start it on demand instead of signing out.
  const windows = `Add-Type -TypeDefinition 'using System;using System.Collections.Generic;using System.Runtime.InteropServices;public static class W{public delegate bool P(IntPtr h,IntPtr l);[DllImport("user32.dll")]public static extern bool EnumWindows(P p,IntPtr l);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);public static List<string> V(){var r=new List<string>();EnumWindows((h,l)=>{if(IsWindowVisible(h)){uint p;GetWindowThreadProcessId(h,out p);r.Add(h.ToInt64()+":"+p);}return true;},IntPtr.Zero);return r;}}';`
  const visible = async () => new Set(JSON.parse(await ps(`${windows}ConvertTo-Json -Compress @([W]::V())`)))
  const visibleBefore = await visible()
  await ps(`Start-ScheduledTask -TaskPath '\\' -TaskName ${psLiteral(name)}`)
  const deadline = Date.now() + 60_000
  let url = "stopped"
  while (Date.now() < deadline && (url = await service(["service", "status"])) === "stopped") await delay(500)
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+/)
  assert.ok(url.includes(`:${port}`), "the task started the isolated service, not the shared one")
  const registration = JSON.parse(await readFile(path.join(environment.XDG_STATE_HOME, "opencode", "service.json"), "utf8"))
  pid = registration.pid
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  await delay(2000)
  const proof = JSON.parse(await ps(`${windows}$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; $kids=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}")
$parent=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"; $owners=@(${pid})+@($kids|%{ [int]$_.ProcessId })
$i=Get-ScheduledTaskInfo -TaskPath '\\' -TaskName ${psLiteral(name)}; $t=Get-ScheduledTask -TaskPath '\\' -TaskName ${psLiteral(name)}
@{ commandLine=$p.CommandLine; executable=$p.ExecutablePath; children=@($kids|%{ $_.Name }); parentAlive=[bool]$parent; parentName=[string]$parent.Name
  mainWindow=[int64](Get-Process -Id ${pid}).MainWindowHandle; visibleWindows=@([W]::V()); owners=$owners
  taskState=[string]$t.State; lastResult=[int64]$i.LastTaskResult }|ConvertTo-Json -Compress -Depth 4`))
  const owned = new Set(proof.owners.map(String))
  const ownedWindows = proof.visibleWindows.filter(entry => owned.has(entry.split(":")[1]))
  const newWindows = proof.visibleWindows.filter(entry => !visibleBefore.has(entry))
  step("service-started-by-task", { url, pid, commandLine: proof.commandLine, executable: proof.executable, children: proof.children,
    launcherParentAlive: proof.parentAlive, parentName: proof.parentName, mainWindow: proof.mainWindow, ownedVisibleWindows: ownedWindows,
    newVisibleWindows: newWindows, taskState: proof.taskState, lastTaskResult: proof.lastResult })
  assert.match(proof.commandLine, /serve --service$/)
  assert.equal(path.resolve(proof.executable).toLowerCase(), path.resolve(await resolveLoginStartLaunch(cli).then(launch => launch.command)).toLowerCase())
  assert.equal(proof.mainWindow, 0)
  assert.deepEqual(ownedWindows, [], "neither OpenCode nor its console host owns a visible window")
  assert.equal(proof.parentAlive && proof.parentName === "opencode-login-launcher.exe", false, "the launcher started OpenCode and exited")
  assert.equal(proof.taskState, "Ready", "the task instance ended while OpenCode keeps running")
  assert.equal(proof.lastResult, 0)

  assert.deepEqual(await loginStart.set(false), { state: "off" })
  assert.deepEqual(await loginStart.set(false), { state: "off" }, "idempotent")
  assert.equal(await ps(`${findTaskScript}if (Find ${psLiteral(name)}) { 'present' } else { 'absent' }`), "absent")
  assert.equal(await service(["service", "status"]), url, "turning it off never stops the running OpenCode")
  assert.equal((await lookupProcess(pid)).state, "live")
  step("task-removed-service-kept", { task: "absent", url })
} finally {
  // Run-owned cleanup only: the isolated service, then the unique task and roots.
  await service(["service", "stop"]).catch(() => {})
  if (pid) for (let i = 0; i < 60 && (await lookupProcess(pid)).state === "live"; i++) await delay(500)
  const after = await ps(`${findTaskScript}try { $t=Find ${psLiteral(name)}; if ($t) { Unregister-ScheduledTask -InputObject $t -Confirm:$false; 'removed-in-cleanup' } else { 'absent' } } catch { 'unknown' }`)
  step("cleanup", { task: after, isolatedProcess: pid ? (await lookupProcess(pid)).state : "never-started" })
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
const afterFingerprint = await fingerprint()
step("shared-registration-after", afterFingerprint)
assert.deepEqual(afterFingerprint, before, "the shared service registration is unchanged")
if (process.argv[3]) {
  await mkdir(process.argv[3], { recursive: true })
  await writeFile(path.join(process.argv[3], "windows-native-evidence.json"), JSON.stringify(evidence, null, 2))
}
console.log("windows-native-login-start: ok")
