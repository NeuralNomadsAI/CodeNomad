param([Parameter(Mandatory=$true)][string]$Directory,
  [Parameter(Mandatory=$true)][string]$Key,
  [ValidateSet('install','remove','observe','Main','Recovery')][string]$Mode,
  [long]$Revision=-1)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
# Only fixed, owned paths are passed by the adapter. The directory has a private
# DACL; user/profile environment and command strings never enter this script.
if ($Key -notmatch '^[a-f0-9]{64}$' -or [IO.Path]::GetFileName($Directory) -ne $Key) { exit 1 }
function ReadJson($file,$limit,$json=$null) {
  $item=Get-Item -LiteralPath $file -Force
  if ($item.PSIsContainer -or ($item.Attributes -band 1024) -ne 0 -or $item.Length -gt $limit) { throw 'invalid-file' }
  $bytes=[IO.File]::ReadAllBytes($file)
  if ($bytes.Length -gt $limit) { throw 'bounded' }
  $text=[Text.Encoding]::UTF8.GetString($bytes)
  if ($json) { $json.Value=$text }
  return $text|ConvertFrom-Json
}
function Manifest {
  $m=ReadJson (Join-Path $Directory 'manifest.json') 65536
  $owner=if($m.namespace.platform -eq 'wsl'){$d.wsl.owner}else{$m.namespace.user}
  if ($m.v -ne 1 -or $m.key -ne $Key -or $m.namespace.platform -notin @('win32','wsl') -or
    $owner -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
    ($m.namespace.platform -eq 'wsl' -and (!$d.wsl -or $m.namespace.distro -ne $d.wsl.distro -or $m.namespace.user -ne $d.wsl.user)) -or
    $m.revision -isnot [long] -and $m.revision -isnot [int] -or $m.revision -lt 0 -or
    $m.desired -notin @('unset','on','off')) { throw 'manifest-identity' }
  return $m
}
function Gate { return [IO.File]::Open((Join-Path $Directory 'admission.lock'),'OpenOrCreate','ReadWrite','None') }
function Atomic($name,$value) {
  $file=Join-Path $Directory $name; $tmp=Join-Path $Directory ([guid]::NewGuid().ToString()+'.tmp')
  try {
    $bytes=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 8 -Compress))
    if ($bytes.Length -gt 32768) { throw 'bounded-status' }
    [IO.File]::WriteAllBytes($tmp,$bytes)
    if ([IO.File]::Exists($file)) { [IO.File]::Replace($tmp,$file,[NullString]::Value) } else { [IO.File]::Move($tmp,$file) }
  } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}
$d=ReadJson (Join-Path $Directory 'windows.json') 32768
if ($d.v -ne 1 -or $d.key -ne $Key -or $d.directory -ne $Directory -or $d.script -ne $PSCommandPath) { exit 1 }
$main="CodeNomad-OpenCode-$Key-Main"; $recovery="CodeNomad-OpenCode-$Key-Recovery"
$marker="CodeNomad OpenCode supervision v1 key=$Key root=$Directory"
function Arguments($kind) {
  return "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$($d.script)`" -Directory `"$Directory`" -Key $Key -Mode $kind"
}
Import-Module (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules/ScheduledTasks/ScheduledTasks.psd1')
function Subscription {
  return "<QueryList><Query Id=`"0`" Path=`"Microsoft-Windows-TaskScheduler/Operational`"><Select Path=`"Microsoft-Windows-TaskScheduler/Operational`">*[System[(EventID=201 or EventID=203)] and EventData[Data[@Name='TaskName']='\$main' and Data[@Name='ResultCode']!='0']]</Select></Query></QueryList>"
}
function Owned($name,$kind) {
  $t=Get-ScheduledTask -TaskPath '\' -TaskName $name -ErrorAction SilentlyContinue
  $sid=$null
  if ($t) {
    $sid=[string]$t.Principal.UserId
    if ($sid -notmatch '^S-1-') { $sid=[Security.Principal.NTAccount]::new($sid).Translate([Security.Principal.SecurityIdentifier]).Value }
  }
  if ($t -and ($t.Description -ne $marker -or $t.Actions.Count -ne 1 -or
    $t.Actions[0].Execute -ne $d.powershell -or $t.Actions[0].Arguments -ne (Arguments $kind) -or
    $t.Actions[0].WorkingDirectory -ne $Directory -or $sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) { throw 'foreign-task' }
  if ($t) {
    $text=Export-ScheduledTask -TaskPath '\' -TaskName $name
    if ($text.Length -gt 32768) { throw 'bounded-task' }
    $xml=[xml]$text; $s=$xml.Task.Settings; $triggers=$xml.Task.Triggers
    $logonUser=[string]$triggers.LogonTrigger.UserId
    if ($logonUser -notmatch '^S-1-') { $logonUser=[Security.Principal.NTAccount]::new($logonUser).Translate([Security.Principal.SecurityIdentifier]).Value }
    $policy=if($kind -eq 'Main'){'IgnoreNew'}else{'Queue'}
    $limit=if($kind -eq 'Main'){'PT0S'}else{'PT10S'}
    if ($s.MultipleInstancesPolicy -ne $policy -or $s.ExecutionTimeLimit -ne $limit -or
      $s.DisallowStartIfOnBatteries -ne 'false' -or $s.StopIfGoingOnBatteries -ne 'false' -or
      $xml.Task.Principals.Principal.LogonType -ne 'InteractiveToken' -or
      [string]$xml.Task.Principals.Principal.RunLevel -notin @('','LeastPrivilege') -or
      [string]$triggers.LogonTrigger.Enabled -notin @('','true') -or $logonUser -ne $sid) { throw 'task-policy-mismatch' }
    foreach ($trigger in $triggers.ChildNodes) {
      if ($trigger.EndBoundary -or [string]$trigger.Delay -notin @('','PT0S') -or
        [string]$trigger.RandomDelay -notin @('','PT0S')) { throw 'task-trigger-boundary' }
    }
    if ($kind -eq 'Main') {
      if ($triggers.ChildNodes.Count -ne 1) { throw 'task-triggers-mismatch' }
    } elseif ($triggers.ChildNodes.Count -ne 3 -or [string]$triggers.EventTrigger.Enabled -notin @('','true') -or
      $triggers.EventTrigger.Subscription -ne (Subscription) -or [string]$triggers.TimeTrigger.Enabled -notin @('','true') -or
      $triggers.TimeTrigger.Repetition.Interval -ne 'PT1M' -or $triggers.TimeTrigger.Repetition.Duration) { throw 'task-triggers-mismatch' }
  }
  return $t
}
function Expected($desired) {
  $m=Manifest
  if ($m.revision -ne $Revision -or $m.desired -ne $desired) { throw 'revision-conflict' }
  return $m
}
function Tasks {
  $a=Owned $main 'Main'; $b=Owned $recovery 'Recovery'
  return @{main=if($a){[string]$a.State}else{'absent'};recovery=if($b){[string]$b.State}else{'absent'}}
}
try {
  if ($Mode -eq 'observe') { Tasks|ConvertTo-Json -Compress; exit 0 }
  if ($Mode -eq 'install') {
    $gate=Gate
    try {
      $m=Expected 'on'; $a=Owned $main 'Main'; $b=Owned $recovery 'Recovery'
      if (!(Get-WinEvent -ListLog 'Microsoft-Windows-TaskScheduler/Operational').IsEnabled) { throw 'event-log-disabled' }
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
      if (!$a) {
        $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([timespan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskPath '\' -TaskName $main -Action (New-ScheduledTaskAction -Execute $d.powershell -Argument (Arguments 'Main') -WorkingDirectory $Directory) -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $sid) -Principal $principal -Settings $settings -Description $marker|Out-Null
      }
      if (!$b) {
        $subscription=Subscription
        $event=New-CimInstance -CimClass (Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskEventTrigger) -ClientOnly
        $event.Enabled=$true; $event.Subscription=$subscription
        $periodic=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
        $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 10) -MultipleInstances Queue -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskPath '\' -TaskName $recovery -Action (New-ScheduledTaskAction -Execute $d.powershell -Argument (Arguments 'Recovery') -WorkingDirectory $Directory) -Trigger @($event,(New-ScheduledTaskTrigger -AtLogOn -User $sid),$periodic) -Principal $principal -Settings $settings -Description $marker|Out-Null
      }
      foreach ($t in @((Owned $main 'Main'),(Owned $recovery 'Recovery'))) { Enable-ScheduledTask -InputObject $t|Out-Null }
      Start-ScheduledTask -InputObject (Owned $main 'Main')
      Tasks|ConvertTo-Json -Compress
    } finally { $gate.Dispose() }
    exit 0
  }
  if ($Mode -eq 'remove') {
    $gate=Gate
    try {
      $m=Expected 'off'; $a=Owned $main 'Main'; $b=Owned $recovery 'Recovery'
      foreach ($t in @($b,$a)) { if ($t) { Disable-ScheduledTask -InputObject $t|Out-Null } }
    } finally { $gate.Dispose() }
    # OFF is the guard's release request. Never End/Stop Main: its foreground
    # child must survive. A blocked release stays visible for an explicit retry.
    $deadline=[datetime]::UtcNow.AddSeconds(12)
    do {
      $null=Expected 'off'; $a=Owned $main 'Main'
      if (!$a -or $a.State -notin @('Running','Queued')) { break }
      Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    if ($a -and $a.State -in @('Running','Queued')) { throw 'release-pending' }
    $gate=Gate
    try {
      $null=Expected 'off'
      foreach ($entry in @(@($recovery,'Recovery'),@($main,'Main'))) {
        $t=Owned $entry[0] $entry[1]
        if ($t) {
          if ($entry[1] -eq 'Recovery') { Stop-ScheduledTask -InputObject $t }
          Unregister-ScheduledTask -InputObject $t -Confirm:$false
        }
      }
      Tasks|ConvertTo-Json -Compress
    } finally { $gate.Dispose() }
    exit 0
  }
  if ($Mode -eq 'Recovery') {
    $m=Manifest; if ($m.desired -ne 'on') { exit 0 }; $rev=$m.revision
    $a=Owned $main 'Main'; $b=Owned $recovery 'Recovery'
    if (!$a -or !$b -or $a.State -in @('Running','Queued')) { exit 0 }
    $last=Join-Path $Directory 'last-start.json'
    if ([IO.File]::Exists($last)) {
      $json=$null; $record=ReadJson $last 1024 ([ref]$json)
      if ($record.key -ne $Key) { throw 'cooldown-identity' }
      # Validate the wire value: ConvertFrom-Json can return DateTime and even
      # normalize invalid offsets. Only the two-field proof written below is accepted.
      $proof=[regex]::Match($json,'\A\s*\{\s*(?:"key"\s*:\s*"[a-f0-9]{64}"\s*,\s*"at"\s*:\s*"(?<at>[^"\\]*)"|"at"\s*:\s*"(?<at>[^"\\]*)"\s*,\s*"key"\s*:\s*"[a-f0-9]{64}")\s*\}\s*\z')
      $at=[datetimeoffset]::MinValue
      if (!$proof.Success -or $proof.Groups['at'].Value -cnotmatch '\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,7})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))\z' -or
        ![datetimeoffset]::TryParse($proof.Groups['at'].Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$at)) { throw 'cooldown-time' }
      if (([datetimeoffset]::UtcNow-$at.ToUniversalTime()).TotalSeconds -lt 5) { exit 0 }
    }
    # One bounded attempt; the independent OS tick retains the retry obligation.
    $gate=$null
    try {
      try { $gate=Gate } catch [IO.IOException] { exit 0 }
      $m=Manifest; if ($m.desired -ne 'on' -or $m.revision -ne $rev) { exit 0 }
      $a=Owned $main 'Main'; $b=Owned $recovery 'Recovery'
      if (!$a -or !$b -or $a.State -in @('Running','Queued')) { exit 0 }
      foreach ($file in @($d.script,$d.node,$d.probe)) { if (![IO.File]::Exists($file)) { throw 'artifact-missing' } }
      Atomic 'last-start.json' @{key=$Key;at=[datetime]::UtcNow.ToString('o')}
      Start-ScheduledTask -InputObject $a
    } finally { if ($gate) { $gate.Dispose() } }
    exit 0
  }
} catch { @{state='failing';cause='windows-resource-operation';line=$_.InvocationInfo.ScriptLineNumber}|ConvertTo-Json -Compress; exit 1 }

# Main owns a foreground handle for the entire ON lifetime. CreateProcessW uses
# only CREATE_UNICODE_ENVIRONMENT: no breakaway, detached flag or finally-kill.
$guard=$null
try { $guard=[IO.File]::Open((Join-Path $Directory 'guard.lock'),'OpenOrCreate','ReadWrite','None') } catch { exit 1 }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodeNomadForeground {
 [StructLayout(LayoutKind.Sequential)] public struct Security { public int length; public IntPtr descriptor; public int inherit; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Startup {
  public int cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xCount,yCount,fill,flags;
  public short show,reserved2; public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo process);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateFileW(string name,uint access,uint share,ref Security security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
}
'@
$child=[CodeNomadForeground+ProcessInfo]::new(); $out=[IntPtr]::Zero; $inputHandle=[IntPtr]::Zero; $memory=[IntPtr]::Zero
$startIdentity='win32:'+([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString())
function Sample([bool]$checkTarget=$false) {
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$d.node
  $info.Arguments="`"$($d.probe)`" `"$Directory`" $Key"
  if ($checkTarget) { $info.Arguments+=' --start' }
  $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
  $info.EnvironmentVariables.Clear()
  foreach ($p in $d.environment.PSObject.Properties) { $info.EnvironmentVariables[$p.Name]=[string]$p.Value }
  $p=[Diagnostics.Process]::Start($info)
  try {
    $stdout=$p.StandardOutput.ReadToEndAsync(); $stderr=$p.StandardError.ReadToEndAsync()
    if (!$p.WaitForExit($(if($checkTarget){12000}else{6000}))) { $p.Kill(); $p.WaitForExit(); throw 'probe-timeout' }
    if ($p.ExitCode -ne 0) { throw 'probe-failed' }
    $text=$stdout.GetAwaiter().GetResult()
    if ($text.Length -gt 32768) { throw 'probe-bounded' }
    return $text|ConvertFrom-Json
  } finally { $p.Dispose() }
}
function QuoteArgument([string]$value) {
  # Windows CommandLineToArgvW quoting, including embedded POSIX shell quotes.
  # wsl.exe also parses its leading switches directly from the raw command line.
  if ($value.Length -gt 0 -and $value -notmatch '[\s"]') { return $value }
  return '"'+[regex]::Replace([regex]::Replace($value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'
}
$statusText=''; $backoff=2; $next=[datetime]::MinValue; $lastAttempt=$null
function Status($m,$health,$hosting,$cause,$retry) {
  $value=@{v=1;key=$Key;revision=$m.revision;guardPid=$PID;guardStart=$startIdentity;childWindowsPid=$child.pid;health=$health;mode=$hosting;cause=$cause;lastAttemptAt=$script:lastAttempt;retryAt=$retry}
  $text=$value|ConvertTo-Json -Depth 8 -Compress
  if ($text -ne $script:statusText) { Atomic 'windows-status.json' $value; $script:statusText=$text }
}
try {
  while ($true) {
    $m=Manifest; if ($m.desired -ne 'on') { break }
    $health=@{state='unknown'}; $cause=$null; $hosting='observed'
    if ($child.process -ne [IntPtr]::Zero) {
      $wait=[CodeNomadForeground]::WaitForSingleObject($child.process,0)
      if ($wait -eq 0) {
        foreach ($h in @($child.process,$child.thread)) { [void][CodeNomadForeground]::CloseHandle($h) }
        $child=[CodeNomadForeground+ProcessInfo]::new()
        $next=[datetime]::UtcNow.AddSeconds($backoff); $backoff=[math]::Min(30,$backoff*2)
      } elseif ($wait -ne 258) { throw 'child-state-unknown' } else { $hosting='hosted' }
    }
    $permitted=$false; $sample=$null
    try { $sample=Sample; if ($sample.revision -eq $m.revision) { $health=$sample.health; $permitted=$sample.permitted -eq $true } } catch { $cause='service-unknown' }
    if ($sample -and $sample.revision -eq $m.revision -and $sample.forwardingUnavailable -eq $true) { $cause='wsl-forwarding-unavailable' }
    if (!$permitted) { $cause='native-service-disabled-or-unknown' }
    if ($health.state -eq 'healthy') { $backoff=2; $next=[datetime]::MinValue }
    # A live hosted child, including slow boot/500/unknown health, is retained.
    if ($permitted -and $health.state -eq 'absent' -and $child.process -eq [IntPtr]::Zero -and [datetime]::UtcNow -ge $next) {
      $gate=$null
      try {
        $gate=Gate; $fresh=Manifest
        if ($fresh.desired -ne 'on' -or $fresh.revision -ne $m.revision) { continue }
        $again=Sample $true
        if ($again.revision -ne $fresh.revision -or $again.health.state -ne 'absent' -or $again.permitted -ne $true) { continue }
        $lastAttempt=[datetime]::UtcNow.ToString('o')
        if ($again.targetReady -ne $true) { throw 'binary-unavailable' }
        $binary=if($d.wsl){[string]$d.wsl.executable}else{[string]$fresh.target.binary}
        if ($binary -notmatch '^[A-Za-z]:\\' -or $binary -match '[\x00-\x1f"]' -or ![IO.File]::Exists($binary)) { throw 'binary-unavailable' }
        if ($out -eq [IntPtr]::Zero) {
          $security=[CodeNomadForeground+Security]::new(); $security.length=[Runtime.InteropServices.Marshal]::SizeOf($security); $security.inherit=1
          # Independent NUL handles avoid pipes tied to the guard or unbounded
          # user output logs. Native OpenCode owns its own log files.
          $out=[CodeNomadForeground]::CreateFileW('NUL',1073741824,3,[ref]$security,3,0,[IntPtr]::Zero)
          $inputHandle=[CodeNomadForeground]::CreateFileW('NUL',2147483648,3,[ref]$security,3,0,[IntPtr]::Zero)
          if ($out -eq [IntPtr](-1) -or $inputHandle -eq [IntPtr](-1)) { throw 'stdio-failed' }
          $block=(@($d.environment.PSObject.Properties|Sort-Object Name|ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "`0")+"`0`0"
          $memory=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($block)
        }
        $startup=[CodeNomadForeground+Startup]::new(); $startup.cb=[Runtime.InteropServices.Marshal]::SizeOf($startup)
        $startup.flags=0x100; $startup.input=$inputHandle; $startup.output=$out; $startup.error=$out
        $argv=if($d.wsl){@($again.launch)}else{@('serve','--service')}
        if ($d.wsl -and ($argv.Count -lt 12 -or $argv[0] -ne '--distribution' -or $argv[1] -ne $d.wsl.distro -or $argv[2] -ne '--user' -or $argv[3] -ne $d.wsl.account)) { throw 'wsl-launch-identity' }
        $command=if($d.wsl){[Text.StringBuilder]::new((( @($binary)+$argv | ForEach-Object { QuoteArgument ([string]$_) }) -join ' '))}else{[Text.StringBuilder]::new("`"$binary`" serve --service")}
        if (![CodeNomadForeground]::CreateProcessW($binary,$command,[IntPtr]::Zero,[IntPtr]::Zero,$true,0x400,$memory,$Directory,[ref]$startup,[ref]$child)) { throw 'spawn-failed' }
        $hosting='hosted'
      } catch { $cause='start-failed'; $next=[datetime]::UtcNow.AddSeconds($backoff); $backoff=[math]::Min(30,$backoff*2) }
      finally { if ($gate) { $gate.Dispose() } }
    }
    Status $m $health $hosting $cause $(if($next -gt [datetime]::UtcNow){$next.ToString('o')}else{$null})
    Start-Sleep -Milliseconds $(if($d.wsl){1000}else{300})
  }
} catch {
  try { Atomic 'windows-status.json' @{v=1;key=$Key;revision=(Manifest).revision;guardPid=$PID;guardStart=$startIdentity;cause='guard-failed';line=$_.InvocationInfo.ScriptLineNumber} } catch {}
  exit 1
}
finally {
  if ($d.wsl -and $child.process -ne [IntPtr]::Zero) {
    # The Linux foreground bridge observes OFF and releases its managed child.
    # Wait for that acknowledgement; never terminate either side of the bridge.
    if ([CodeNomadForeground]::WaitForSingleObject($child.process,8000) -ne 0) { exit 1 }
  }
  foreach ($h in @($child.process,$child.thread,$out,$inputHandle)) { if ($h -ne [IntPtr]::Zero -and $h -ne [IntPtr](-1)) { [void][CodeNomadForeground]::CloseHandle($h) } }
  if ($memory -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($memory) }
  $guard.Dispose()
}
