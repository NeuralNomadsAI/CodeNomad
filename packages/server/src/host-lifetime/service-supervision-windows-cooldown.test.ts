import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

// Execute the complete shipped Recovery branch, with only its clock substituted.
// Scheduler commands are in-process stubs: this test never creates an OS task.
const fixture = String.raw`
param([string]$Guard,[string]$Root)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
function Assert($ok,$message) { if (!$ok) { throw $message } }
$source=[IO.File]::ReadAllText($Guard)
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
Assert ($errors.Count -eq 0) 'guard syntax'
$reader=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'ReadJson'},$true)
. ([scriptblock]::Create($reader.Extent.Text))
$source=$source.Replace('[datetimeoffset]::UtcNow','$global:CooldownNow').Replace('[datetime]::UtcNow','$global:CooldownNow.UtcDateTime')
[void][IO.Directory]::CreateDirectory($Root)
$script=Join-Path $Root 'guard.ps1'; [IO.File]::WriteAllText($script,$source)
$key='a'*64; $directory=Join-Path $Root $key; [void][IO.Directory]::CreateDirectory($directory)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$descriptor=@{v=1;key=$key;directory=$directory;script=$script;powershell='unused.exe';node=$script;probe=$script}
[IO.File]::WriteAllText((Join-Path $directory 'windows.json'),($descriptor|ConvertTo-Json -Compress))
$manifest=@{v=1;key=$key;revision=1;desired='on';namespace=@{platform='win32';user=$sid}}
[IO.File]::WriteAllText((Join-Path $directory 'manifest.json'),($manifest|ConvertTo-Json -Depth 4 -Compress))
$last=Join-Path $directory 'last-start.json'
$global:Starts=0; $global:Refuse=$false; $global:MainState='Ready'
function Import-Module { param($Name) Assert ($Name.EndsWith('ScheduledTasks.psd1')) 'unexpected module' }
function Get-ScheduledTask {
  param($TaskPath,$TaskName,$ErrorAction)
  $kind=if($TaskName.EndsWith('-Main')){'Main'}else{'Recovery'}
  return [pscustomobject]@{Description=$marker;Actions=@([pscustomobject]@{Execute=$d.powershell;Arguments=(Arguments $kind);WorkingDirectory=$Directory});Principal=@{UserId=$sid};State=$(if($kind -eq 'Main'){$global:MainState}else{'Ready'})}
}
function Export-ScheduledTask {
  param($TaskPath,$TaskName)
  $kind=if($TaskName.EndsWith('-Main')){'Main'}else{'Recovery'}
  $policy=if($kind -eq 'Main'){'IgnoreNew'}else{'Queue'}
  $limit=if($kind -eq 'Main'){'PT0S'}else{'PT10S'}
  $extra=if($kind -eq 'Recovery'){'<EventTrigger><Subscription>'+[Security.SecurityElement]::Escape((Subscription))+'</Subscription></EventTrigger><TimeTrigger><Repetition><Interval>PT1M</Interval></Repetition></TimeTrigger>'}else{''}
  return '<Task><Principals><Principal><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>'+$policy+'</MultipleInstancesPolicy><ExecutionTimeLimit>'+$limit+'</ExecutionTimeLimit><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries></Settings><Triggers><LogonTrigger><UserId>'+$sid+'</UserId></LogonTrigger>'+$extra+'</Triggers></Task>'
}
function Start-ScheduledTask {
  param($InputObject)
  $global:Starts++
  if($global:Refuse){throw 'test-start-refusal'}
}
$results=@(); $nativeTypes=@()
function Check($name,$json,$now,$code,$starts) {
  $global:CooldownNow=[datetimeoffset]::Parse($now,[Globalization.CultureInfo]::InvariantCulture)
  if($null -eq $json){[IO.File]::Delete($last)}else{[IO.File]::WriteAllText($last,$json)}
  $before=$global:Starts
  $output=@(& $script -Directory $directory -Key $key -Mode Recovery)
  Assert ($LASTEXITCODE -eq $code) ($name+': exit '+$LASTEXITCODE+' expected '+$code+' '+($output -join ' '))
  Assert ($global:Starts-$before -eq $starts) ($name+': Start count')
  if($starts -eq 0 -and $null -ne $json){Assert ([IO.File]::ReadAllText($last) -ceq $json) ($name+': proof preserved')}
  if($starts -eq 1){
    $written=ReadJson $last 1024
    Assert ($written.key -eq $key) ($name+': written identity')
    $wire=[IO.File]::ReadAllText($last)
    Assert ($wire -match '"at":"[^"]+Z"') ($name+': UTC writer')
  }
  $script:results+=@{name=$name;code=$LASTEXITCODE;starts=$global:Starts-$before}
}
function Proof($at){return '{"key":"'+$key+'","at":"'+$at+'"}'}
$now='2026-11-01T07:41:25.0669287Z'
$cases=@(
  @('UTC expired','2026-11-01T07:41:05.5654997Z',$now,1),
  @('positive offset expired','2026-11-01T08:41:05.5654997+01:00',$now,1),
  @('negative offset expired','2026-11-01T00:41:05.5654997-07:00',$now,1),
  @('maximum positive offset','2026-11-01T21:41:05.5654997+14:00',$now,1),
  @('maximum negative offset','2026-10-31T17:41:05.5654997-14:00',$now,1),
  @('UTC recent','2026-11-01T07:41:22.0669287Z',$now,0),
  @('positive offset recent','2026-11-01T13:11:22.0669287+05:30',$now,0),
  @('negative offset recent','2026-11-01T04:11:22.0669287-03:30',$now,0),
  @('one tick before boundary','2026-11-01T07:41:20.0669288Z',$now,0),
  @('exact five seconds','2026-11-01T07:41:20.0669287Z',$now,1),
  @('clock rollback','2026-11-01T07:42:25.0669287Z',$now,0),
  @('DST spring recent','2026-03-29T01:59:59+01:00','2026-03-29T03:00:01+02:00',0),
  @('DST spring expired','2026-03-29T01:59:59+01:00','2026-03-29T03:00:05+02:00',1),
  @('DST fall recent','2026-10-25T02:59:59+02:00','2026-10-25T02:00:01+01:00',0),
  @('DST repeated hour expired','2026-10-25T02:00:00+02:00','2026-10-25T02:00:01+01:00',1)
)
foreach($case in $cases){
  $json=Proof $case[1]; [IO.File]::WriteAllText($last,$json)
  $nativeTypes+=(ReadJson $last 1024).at.GetType().FullName
  Check $case[0] $json $case[2] 0 $case[3]
}
$invalid=@('','garbage','2026-11-01T07:41:05','2026-11-01T07:41:05z','2026-11-01T07:41:05Z ',
  '2026-11-01T07:41:05+01:60','2026-11-01T07:41:05-01:60','2026-11-01T07:41:05+14:01',
  '2026-11-01T07:41:05+15:00','2026-11-01T07:41:05-15:00','2026-11-01T07:41:05+0100',
  '2026-11-01T07:41:05+01','2026-11-01T07:41:05+01:-1','2026-11-01T07:41:05.12345678Z',
  '2026-02-29T07:41:05Z','2026-11-01T07:41:60Z','2026-13-01T07:41:05Z')
foreach($at in $invalid){Check ('invalid '+$at) (Proof $at) $now 1 0}
foreach($value in @('null','123','true','[]','{}')){Check ('invalid type '+$value) ('{"key":"'+$key+'","at":'+$value+'}') $now 1 0}
Check 'missing at' ('{"key":"'+$key+'"}') $now 1 0
Check 'duplicate at' ('{"key":"'+$key+'","at":"2000-01-01T00:00:00Z","at":"2000-01-01T00:00:01Z"}') $now 1 0
Check 'escaped at key' ('{"key":"'+$key+'","\u0061t":"2000-01-01T00:00:00Z"}') $now 1 0
Check 'wrong key' ('{"key":"'+('b'*64)+'","at":"2000-01-01T00:00:00Z"}') $now 1 0
Check 'invalid JSON' '{' $now 1 0
Check 'over bound' (' '*1025) $now 1 0
Check 'at first, whitespace' ('{ "at" : "2000-01-01T00:00:00Z", "key" : "'+$key+'" }') $now 0 1
Check 'missing proof' $null $now 0 1
$global:Refuse=$true
Check 'transient Start refusal' (Proof '2026-11-01T07:41:05Z') $now 1 1
$refused=[IO.File]::ReadAllText($last); $global:Refuse=$false
Check 'tick within refused cooldown' $refused '2026-11-01T07:41:29.0669287Z' 0 0
Check 'tick after refused cooldown' $refused '2026-11-01T07:41:30.0669287Z' 0 1
$global:MainState='Running'
Check 'active Main' (Proof '2000-01-01T00:00:00Z') $now 0 0
@{version=$PSVersionTable.PSVersion.ToString();nativeTypes=@($nativeTypes|Select-Object -Unique);cases=$results;clockChanged=$false;osTasksCreated=0}|ConvertTo-Json -Depth 5 -Compress
`

test("Recovery cooldown uses UTC instants and rejects invalid proof in Windows PowerShell and pwsh", {
  skip: process.platform !== "win32",
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervision-cooldown-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const guard = process.env.CODENOMAD_COOLDOWN_GUARD
    ?? path.join(import.meta.dirname, "service-supervision-windows.ps1")
  const script = path.join(root, "test.ps1")
  await writeFile(script, fixture)
  const windows = process.env.SystemRoot ?? "C:\\Windows"
  const powershell = path.join(windows, "System32/WindowsPowerShell/v1.0/powershell.exe")
  const pwsh = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell/7/pwsh.exe")
  const shells = [powershell]
  try { await access(pwsh); shells.push(pwsh) } catch { t.diagnostic("pwsh 7 not installed") }
  for (const [index, shell] of shells.entries()) {
    await t.test(path.basename(shell), async () => {
      const output = path.join(root, String(index))
      const { stdout } = await promisify(execFile)(shell, ["-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", script, "-Guard", guard, "-Root", output], {
        windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024,
        env: { SystemRoot: windows, TEMP: root, TMP: root },
      })
      const result = JSON.parse(stdout.trim())
      assert.ok(result.cases.length >= 45)
      assert.equal(result.clockChanged, false)
      assert.equal(result.osTasksCreated, 0)
      assert.ok(result.nativeTypes.includes(index === 0 ? "System.String" : "System.DateTime"))
      t.diagnostic(`${result.version}: ${result.cases.length} Recovery cases; ${result.nativeTypes.join(", ")}`)
    })
  }
})
