import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { ServiceSupervisionStore } from "./service-supervision-store"
import { WindowsServiceSupervision, readWindowsSupervisionRuntime, type WindowsSupervisionRuntime } from "./service-supervision-windows"
import { provisionSupervisionRuntime, windowsSupervisionSources } from "./service-supervision-runtime"

// Run the shipped upgrade branch. Only Scheduler commands are stubs; no OS
// registration, service, preference control or clock change occurs here.
const fixture = String.raw`
param([string]$Guard,[string]$Root)
$ErrorActionPreference='Stop'
function Assert($ok,$message){if(!$ok){throw $message}}
$key='a'*64;$directory=Join-Path $Root $key;[void][IO.Directory]::CreateDirectory($directory)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$old=Join-Path $Root 'old guard.ps1';$launcher=Join-Path $Root 'launcher.exe'
[IO.File]::WriteAllText($old,'old');[IO.File]::WriteAllText($launcher,'test')
$main="CodeNomad-OpenCode-$key-Main";$recovery="CodeNomad-OpenCode-$key-Recovery"
$marker="CodeNomad OpenCode supervision v1 key=$key root=$directory"
$manifest=Join-Path $directory 'manifest.json';$descriptor=Join-Path $directory 'windows.json'
function Import-Module {param($Name) Assert ($Name.EndsWith('ScheduledTasks.psd1')) 'module'}
function Get-ScheduledTask {param($TaskPath,$TaskName,$ErrorAction) Assert ($TaskPath -eq '\') 'task path';return $global:tasks[$TaskName]}
function Export-ScheduledTask {
 param($TaskPath,$TaskName)
 $kind=if($TaskName -eq $main){'Main'}else{'Recovery'}
 $policy=if($kind -eq 'Main'){'IgnoreNew'}else{'Queue'}
 $limit=if($kind -eq 'Main'){'PT0S'}else{'PT10S'}
 if($global:badPolicy){$policy='Parallel'}
 $extra=if($kind -eq 'Recovery'){'<EventTrigger><Subscription>'+[Security.SecurityElement]::Escape((Subscription))+'</Subscription></EventTrigger><TimeTrigger><Repetition><Interval>PT1M</Interval></Repetition></TimeTrigger>'}else{''}
 return '<Task><Principals><Principal><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>'+$policy+'</MultipleInstancesPolicy><ExecutionTimeLimit>'+$limit+'</ExecutionTimeLimit><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries></Settings><Triggers><LogonTrigger><UserId>'+$sid+'</UserId></LogonTrigger>'+$extra+'</Triggers></Task>'
}
function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) return [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory}}
function Set-ScheduledTask {
 param($TaskPath,$TaskName,$Action)
 Assert ($TaskPath -eq '\' -and $global:tasks.ContainsKey($TaskName)) 'exact task'
 $h=$null;try{$h=[IO.File]::Open((Join-Path $directory 'admission.lock'),'OpenOrCreate','ReadWrite','None');throw 'upgrade did not hold admission'}catch [IO.IOException]{}finally{if($h){$h.Dispose()}}
 $global:sets++
 if($global:refuseSecond -and $global:sets -eq 2){throw 'partial action update'}
 if($global:ignoreSecond -and $global:sets -eq 2){return}
 $global:tasks[$TaskName].Actions=@($Action)
}
function Start-ScheduledTask {throw 'unexpected start'}
function Register-ScheduledTask {throw 'unexpected registration'}
function Enable-ScheduledTask {throw 'unexpected enable'}
function Stop-ScheduledTask {throw 'unexpected stop'}
function Reset($desired='on'){
 $global:sets=0;$global:badPolicy=$false;$global:refuseSecond=$false;$global:ignoreSecond=$false;$global:tasks=@{}
 [IO.File]::WriteAllText($manifest,(@{v=1;key=$key;revision=9;desired=$desired;namespace=@{platform='win32';user=$sid}}|ConvertTo-Json -Depth 4 -Compress))
 [IO.File]::WriteAllText($descriptor,(@{v=1;key=$key;directory=$directory;script=$old;powershell='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';node=$old;probe=$old}|ConvertTo-Json -Compress))
 foreach($kind in @('Main','Recovery')){
  $name="CodeNomad-OpenCode-$key-$kind"
  $args='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$old+'" -Directory "'+$directory+'" -Key '+$key+' -Mode '+$kind
  $global:tasks[$name]=[pscustomobject]@{TaskName=$name;Description=$marker;Actions=@([pscustomobject]@{Execute='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';Arguments=$args;WorkingDirectory=$directory});Principal=@{UserId=$sid};State='Ready'}
 }
}
function InvokeUpgrade($revision=9){$output=@(& $Guard -Directory $directory -Key $key -Mode upgrade -Revision $revision -Launcher $launcher);return $LASTEXITCODE}
function Success {
 $d=[IO.File]::ReadAllText($descriptor)|ConvertFrom-Json
 Assert ($d.script -eq $Guard -and $d.launcher -eq $launcher -and !$d.previousScript) 'descriptor publication'
 foreach($kind in @('Main','Recovery')){
  $a=$global:tasks["CodeNomad-OpenCode-$key-$kind"].Actions[0]
  Assert ($a.Execute -eq $launcher -and $a.Arguments.StartsWith('"'+$d.powershell+'" ') -and $a.Arguments.Contains('-WindowStyle Hidden') -and $a.Arguments.EndsWith('-Mode '+$kind)) 'windowless action'
 }
}
$checks=@()
foreach($desired in @('on','off','unset')){
 Reset $desired;$before=[IO.File]::ReadAllText($manifest)
 Assert ((InvokeUpgrade) -eq 0) ('upgrade '+$desired);Success
 Assert ([IO.File]::ReadAllText($manifest) -ceq $before) 'intent/revision/receipt changed'
 $checks+='preserves '+$desired
}
Reset;$global:refuseSecond=$true
Assert ((InvokeUpgrade) -eq 1 -and $global:sets -eq 2) 'partial refusal'
$pending=[IO.File]::ReadAllText($descriptor)|ConvertFrom-Json
Assert ($pending.previousScript -eq $old -and $pending.script -eq $Guard -and $pending.launcher -eq $launcher) 'pending artifact identities'
$global:refuseSecond=$false
Assert ((InvokeUpgrade) -eq 0) 'partial recovery';Success;$checks+='partial retry'
Reset;$global:ignoreSecond=$true
Assert ((InvokeUpgrade) -eq 1) 'strict action readback'
Assert (([IO.File]::ReadAllText($descriptor)|ConvertFrom-Json).previousScript -eq $old) 'readback retains pending artifacts'
$global:ignoreSecond=$false
Assert ((InvokeUpgrade) -eq 0) 'readback retry';Success;$checks+='strict readback'
foreach($fault in @('arguments','marker','principal','policy','revision')){
 Reset;$before=[IO.File]::ReadAllText($descriptor)
 switch($fault){
  'arguments' {$global:tasks[$recovery].Actions[0].Arguments+=' -Foreign'}
  'marker' {$global:tasks[$recovery].Description='foreign'}
  'principal' {$global:tasks[$recovery].Principal.UserId='S-1-5-18'}
  'policy' {$global:badPolicy=$true}
 }
 $revision=if($fault -eq 'revision'){8}else{9}
 Assert ((InvokeUpgrade $revision) -eq 1) ('refuse '+$fault)
 Assert ($global:sets -eq 0 -and [IO.File]::ReadAllText($descriptor) -ceq $before) ('preserve '+$fault)
 $checks+='refused '+$fault
}
Reset;$global:tasks=@{};$before=[IO.File]::ReadAllText($manifest)
Assert ((InvokeUpgrade) -eq 0 -and $global:sets -eq 0) 'absent tasks'
Assert ([IO.File]::ReadAllText($manifest) -ceq $before) 'absent intent'
$checks+='absent tasks stay absent'
@{checks=$checks;osTasks=0}|ConvertTo-Json -Compress
`

test("owned action migration fences intent and collisions, and resumes partial publication", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervision-upgrade-")), file = path.join(root, "test.ps1")
  await writeFile(file, fixture)
  const { stdout } = await promisify(execFile)(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, "-Root", root,
      "-Guard", path.join(import.meta.dirname, "service-supervision-windows.ps1")], { windowsHide: true, timeout: 30_000 })
  const result = JSON.parse(stdout.trim())
  assert.equal(result.checks.length, 11)
  assert.equal(result.osTasks, 0)
})

test("TypeScript acquisition upgrades pinned metadata without changing OFF, revision or receipt", { skip: process.platform !== "win32" }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervision-acquisition-")), exec = promisify(execFile)
  const powershell = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
  const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true, timeout: 5000 })
  const namespace = { platform: "win32" as const, host: "fixture", user: stdout.trim(), configDirectory: path.join(root, "opencode"), stateDirectory: path.join(root, "opencode"), registrationName: "service.json" }
  const policy = { async verify(file: string, directory: boolean) {
    const stat = await lstat(file)
    assert.ok(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1))
  } }
  const store = new ServiceSupervisionStore(root, namespace, { binary: path.join(root, "unused.exe"), provenance: "custom" }, policy)
  await store.control({ action: "off", expectedRevision: 0, requestID: randomUUID() })
  await store.acknowledge(1)
  const bytes = await readFile(path.join(store.directory, "manifest.json"), "utf8")
  const source = path.join(root, "old.txt")
  await writeFile(source, "owned inert artifact")
  const artifacts = await provisionSupervisionRuntime(store.directory, policy, { node: source, script: source, probe: source })
  const environment = Object.fromEntries(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TEMP", "TMP"].map(key => [key, root])) as WindowsSupervisionRuntime["environment"]
  Object.assign(environment, { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, COMSPEC: path.join(process.env.SystemRoot!, "System32/cmd.exe") })
  const runtime = { powershell, ...artifacts, environment }
  const manifest = await store.read()
  await writeFile(path.join(store.directory, "windows.json"), JSON.stringify({ v: 1, key: manifest.key, directory: store.directory, ...runtime }))
  const saved = { ...windowsSupervisionSources }
  t.after(() => Object.assign(windowsSupervisionSources, saved))
  // Test-owned build inputs; the published files still use the real content
  // hashing, collision checks, descriptor validation and native upgrade branch.
  Object.assign(windowsSupervisionSources, { script: path.join(import.meta.dirname, "service-supervision-windows.ps1"), launcher: source })
  await new WindowsServiceSupervision(store, runtime, policy, policy).prepareRuntime()
  const current = (await readWindowsSupervisionRuntime(store, policy))!
  assert.ok(current.launcher)
  assert.equal(current.previousScript, undefined)
  assert.equal(current.node, runtime.node)
  assert.equal(current.probe, runtime.probe)
  assert.notEqual(current.script, runtime.script)
  assert.equal(createHash("sha256").update(await readFile(current.script)).digest("hex"), path.basename(current.script, ".ps1"))
  await new WindowsServiceSupervision(store, current, policy, policy).prepareRuntime()
  await writeFile(path.join(store.directory, "windows.json"), JSON.stringify({ v: 1, key: manifest.key, directory: store.directory,
    ...current, previousScript: runtime.script }))
  const pending = (await readWindowsSupervisionRuntime(store, policy))!
  Object.assign(windowsSupervisionSources, { script: path.join(root, "replaced-package.ps1"), launcher: path.join(root, "replaced-package.exe") })
  await new WindowsServiceSupervision(store, pending, policy, policy).prepareRuntime()
  const resumed = (await readWindowsSupervisionRuntime(store, policy))!
  assert.equal(resumed.script, current.script)
  assert.equal(resumed.launcher, current.launcher)
  assert.equal(resumed.previousScript, undefined)
  assert.equal(await readFile(path.join(store.directory, "manifest.json"), "utf8"), bytes)
})
