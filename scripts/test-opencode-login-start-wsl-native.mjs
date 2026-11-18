// node --import tsx scripts/test-opencode-login-start-wsl-native.mjs DISTRO LINUX_CLI LINUX_ROOT [EVIDENCE_DIRECTORY]
// Requires `npm run build:host-helpers --workspace @neuralnomads/codenomad`. LINUX_CLI is an OpenCode 2
// executable inside DISTRO; LINUX_ROOT is a run-owned directory there for the isolated XDG roots. Only a
// uniquely named Windows task, that isolated service (own XDG roots and port) and run-owned files are
// created; the run removes them and compares the shared Windows service registration before and after.
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

assert.equal(process.platform, "win32")
const [distro, cli, linuxRoot] = process.argv.slice(2)
assert.ok(distro && cli?.startsWith("/") && linuxRoot?.startsWith("/"), "DISTRO LINUX_CLI LINUX_ROOT")
const exec = promisify(execFile)
const evidence = { steps: [] }
const step = (name, value) => { evidence.steps.push({ name, ...value }); console.log(name, JSON.stringify(value)) }
const shared = path.join(os.homedir(), ".local/state/opencode/service.json")
const fingerprint = async () => ({ sha256: createHash("sha256").update(await readFile(shared)).digest("hex"),
  lastWriteTimeUtc: (await stat(shared)).mtime.toISOString() })
const before = await fingerprint()
step("shared-registration-before", before)

// Linux-side isolation crosses wsl.exe through WSLENV, unchanged (/u), exactly as a session variable would.
const linux = { XDG_CONFIG_HOME: `${linuxRoot}/config`, XDG_STATE_HOME: `${linuxRoot}/state`, XDG_DATA_HOME: `${linuxRoot}/data`,
  XDG_CACHE_HOME: `${linuxRoot}/cache`, OPENCODE_TEST_HOME: `${linuxRoot}/home` }
const wslenv = Object.keys(linux).map(key => `${key}/u`).join(":")
const wsl = async (args, timeout = 30_000) => (await exec("wsl.exe", ["--distribution", distro, "--exec", ...args],
  { windowsHide: true, timeout, maxBuffer: 1024 * 1024, env: { ...process.env, WSL_UTF8: "1" } })).stdout.trim()
const service = args => wsl(["/usr/bin/env", ...Object.entries(linux).map(([key, value]) => `${key}=${value}`), cli, ...args])
const ps = runPowerShell

await mkdir(path.join(os.tmpdir(), "opencode"), { recursive: true })
const root = await mkdtemp(path.join(os.tmpdir(), "opencode", "login start wsl "))
const id = randomUUID(), name = `CodeNomad-OpenCode-Login-Test-${id}`, marker = `CodeNomad: start OpenCode at login (WSL qualification ${id})`
const launcherSource = fileURLToPath(new URL("../packages/server/dist/host-lifetime/opencode-login-launcher.exe", import.meta.url))
const exists = file => wsl(["/usr/bin/test", "-e", file]).then(() => true, () => false)
// Checked before anything is created: cleanup removes LINUX_ROOT only when this run created it.
assert.equal(await exists(linuxRoot), false, "LINUX_ROOT is run-owned")
let pid, ownsRoot = false
try {
  // Without -p, mkdir fails on an existing directory: success proves this run owns LINUX_ROOT.
  await wsl(["/bin/mkdir", "--", linuxRoot])
  ownsRoot = true
  await wsl(["/bin/mkdir", "-p", ...Object.values(linux)])
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  assert.notEqual(port, 28894)
  await service(["service", "set", "port", String(port)])
  assert.equal(await service(["service", "status"]), "stopped")
  step("isolated-service", { distro, cli, linuxRoot, port, task: name, version: await wsl([cli, "--version"]) })

  const selected = `\\\\wsl.localhost\\${distro}${cli.replaceAll("/", "\\")}`
  const launch = await resolveLoginStartLaunch(selected)
  assert.deepEqual(launch, { command: path.win32.join(process.env.SystemRoot, "System32", "wsl.exe"),
    args: ["--distribution", distro, "--exec", cli, "serve", "--service"] })
  const platform = new WindowsLoginStart({ name, marker, launcherSource, launcherDirectory: path.join(root, "launcher"),
    environment: { ...linux, WSLENV: wslenv } })
  const loginStart = new OpenCodeLoginStart({ platform, launch: () => resolveLoginStartLaunch(selected) })
  assert.deepEqual(await loginStart.set(true), { state: "on" })
  const task = JSON.parse(await ps(`$t=Get-ScheduledTask -TaskPath '\\' -TaskName ${psLiteral(name)}; $x=[xml](Export-ScheduledTask -TaskPath '\\' -TaskName ${psLiteral(name)})
$u=[string]$x.Task.Triggers.LogonTrigger.UserId; if ($u -notmatch '^S-1-') { $u=[Security.Principal.NTAccount]::new($u).Translate([Security.Principal.SecurityIdentifier]).Value }
@{ sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; triggers=@($x.Task.Triggers.ChildNodes|%{ $_.LocalName }); trigger=$u
  logon=[string]$x.Task.Principals.Principal.LogonType; level=[string]$t.Principal.RunLevel; execute=$t.Actions[0].Execute; arguments=$t.Actions[0].Arguments }|ConvertTo-Json -Compress`))
  assert.deepEqual(task.triggers, ["LogonTrigger"])
  assert.equal(task.trigger, task.sid)
  assert.equal(task.logon, "InteractiveToken")
  assert.equal(task.level, "Limited")
  assert.match(task.arguments, new RegExp(`-- ${launch.command.replace(/\\/g, "\\\\")} --distribution ${distro} --exec ${cli} serve --service$`))
  step("task-registered", { triggers: task.triggers, logon: task.logon, level: task.level, execute: task.execute,
    action: task.arguments.slice(task.arguments.indexOf(" -- ") + 4) })

  const windows = `Add-Type -TypeDefinition 'using System;using System.Collections.Generic;using System.Runtime.InteropServices;public static class W{public delegate bool P(IntPtr h,IntPtr l);[DllImport("user32.dll")]public static extern bool EnumWindows(P p,IntPtr l);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);public static List<string> V(){var r=new List<string>();EnumWindows((h,l)=>{if(IsWindowVisible(h)){uint p;GetWindowThreadProcessId(h,out p);r.Add(h.ToInt64()+":"+p);}return true;},IntPtr.Zero);return r;}}';`
  const visibleBefore = new Set(JSON.parse(await ps(`${windows}ConvertTo-Json -Compress @([W]::V())`)))
  await ps(`Start-ScheduledTask -TaskPath '\\' -TaskName ${psLiteral(name)}`)
  const deadline = Date.now() + 90_000
  let url = "stopped"
  while (Date.now() < deadline && (url = await service(["service", "status"])) === "stopped") await delay(1000)
  assert.equal(url, `http://127.0.0.1:${port}`, "the task started the isolated service on its own port")
  const registration = JSON.parse(await wsl(["/bin/cat", `${linux.XDG_STATE_HOME}/opencode/service.json`]))
  pid = registration.pid
  await delay(2000)
  const linuxProof = JSON.parse(await wsl(["/usr/bin/python3", "-c", `import json,os,subprocess
p=${Number(pid)}
cmd=open(f"/proc/{p}/cmdline","rb").read().split(b"\\0")
env=dict(e.split("=",1) for e in open(f"/proc/{p}/environ","rb").read().decode().split("\\0") if "=" in e)
listen=subprocess.run(["ss","-Hltnp",f"sport = :${port}"],capture_output=True,text=True).stdout
print(json.dumps({"cmdline":[c.decode() for c in cmd if c],"xdg":{k:env.get(k) for k in ${JSON.stringify(Object.keys(linux))}},"listening":listen.strip()}))`]))
  assert.deepEqual(linuxProof.cmdline, [cli, "serve", "--service"])
  assert.deepEqual(linuxProof.xdg, linux)
  assert.match(linuxProof.listening, new RegExp(`pid=${pid}\\b`))
  const reachable = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(5000) }).then(response => response.status)
  const proof = JSON.parse(await ps(`${windows}$w=@(Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | ? { $_.CommandLine -like ${psLiteral(`*${cli} serve --service*`)} })
$ids=@($w|%{ [int]$_.ProcessId }); $kids=@($ids|%{ Get-CimInstance Win32_Process -Filter "ParentProcessId=$_" }); $owners=$ids+@($kids|%{ [int]$_.ProcessId })
$i=Get-ScheduledTaskInfo -TaskPath '\\' -TaskName ${psLiteral(name)}; $t=Get-ScheduledTask -TaskPath '\\' -TaskName ${psLiteral(name)}
@{ clients=@($w|%{ $_.CommandLine }); children=@($kids|%{ $_.Name }); mainWindows=@($ids|%{ [int64](Get-Process -Id $_).MainWindowHandle })
  parents=@($w|%{ $pp=Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)"; [string]$pp.Name }); visibleWindows=@([W]::V()); owners=$owners
  taskState=[string]$t.State; lastResult=[int64]$i.LastTaskResult }|ConvertTo-Json -Compress -Depth 4`))
  const owned = new Set(proof.owners.map(String))
  const ownedWindows = proof.visibleWindows.filter(entry => owned.has(entry.split(":")[1]))
  const newWindows = proof.visibleWindows.filter(entry => !visibleBefore.has(entry))
  step("service-started-by-task", { url, linuxPid: pid, cmdline: linuxProof.cmdline, xdg: linuxProof.xdg, listening: linuxProof.listening,
    windowsHttpStatus: reachable, wslClients: proof.clients, wslClientParents: proof.parents, children: proof.children,
    mainWindows: proof.mainWindows, ownedVisibleWindows: ownedWindows, newVisibleWindows: newWindows, taskState: proof.taskState, lastTaskResult: proof.lastResult })
  // System32\wsl.exe relays to the WSL package's wsl.exe with the same command line: one chain of hidden clients.
  assert.ok(proof.clients.length >= 1 && proof.parents.filter(parent => parent !== "wsl.exe").length === 1)
  assert.ok(proof.mainWindows.every(handle => handle === 0))
  assert.deepEqual(ownedWindows, [], "neither wsl.exe nor its console host owns a visible window")
  assert.deepEqual(proof.parents.filter(parent => parent !== "wsl.exe"), [""], "the launcher started wsl.exe and exited")
  assert.equal(proof.taskState, "Ready")
  assert.equal(proof.lastResult, 0)
  assert.equal(reachable, 401, "Windows reaches the isolated port through localhost forwarding; the service requires its credentials")

  assert.deepEqual(await loginStart.set(false), { state: "off" })
  assert.equal(await ps(`${findTaskScript}if (Find ${psLiteral(name)}) { 'present' } else { 'absent' }`), "absent")
  assert.equal(await service(["service", "status"]), url, "turning it off never stops the running OpenCode")
  assert.equal(await wsl(["/bin/sh", "-c", `test -d /proc/${Number(pid)} && echo live || echo dead`]), "live")
  step("task-removed-service-kept", { task: "absent", url, linuxPid: pid })
} finally {
  // Run-owned cleanup only: the isolated service, then the unique task and both roots.
  await service(["service", "stop"]).catch(() => {})
  let state = "never-started"
  if (pid) for (let i = 0; i < 60; i++) {
    state = await wsl(["/bin/sh", "-c", `test -d /proc/${Number(pid)} && echo live || echo dead`]).catch(() => "unknown")
    if (state === "dead") break
    await delay(500)
  }
  let clients = "unknown"
  for (let i = 0; i < 40; i++) {
    clients = await ps(`@(Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | ? { $_.CommandLine -like ${psLiteral(`*${cli} serve --service*`)} }).Count`)
    if (clients === "0") break
    await delay(500)
  }
  const task = await ps(`${findTaskScript}try { $t=Find ${psLiteral(name)}; if ($t) { Unregister-ScheduledTask -InputObject $t -Confirm:$false; 'removed-in-cleanup' } else { 'absent' } } catch { 'unknown' }`)
  if (ownsRoot) await wsl(["/bin/rm", "-rf", "--", linuxRoot]).catch(() => {})
  step("cleanup", { task, linuxProcess: state, wslClients: clients,
    linuxRoot: ownsRoot ? (await exists(linuxRoot) ? "present" : "absent") : "not-created" })
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
const afterFingerprint = await fingerprint()
step("shared-registration-after", afterFingerprint)
assert.deepEqual(afterFingerprint, before, "the shared service registration is unchanged")
if (process.argv[5]) {
  await mkdir(process.argv[5], { recursive: true })
  await writeFile(path.join(process.argv[5], "wsl-native-evidence.json"), JSON.stringify(evidence, null, 2))
}
console.log("wsl-native-login-start: ok")
