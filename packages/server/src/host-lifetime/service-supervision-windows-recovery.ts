import { execFile } from "node:child_process"
import type { WindowsSupervisionRuntime } from "./service-supervision-windows"

/** Observation stays available when the durable action script is missing. The
 * exact owned OS definition, rather than a computed now+60s estimate, supplies
 * the independent retry date. This reader has no task mutation commands. */
export async function readWindowsRecovery(runtime: WindowsSupervisionRuntime, directory: string, key: string): Promise<string | undefined> {
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
  const name = `CodeNomad-OpenCode-${key}-Recovery`
  const args = `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${runtime.script}" -Directory "${directory}" -Key ${key} -Mode Recovery`
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
    Import-Module (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules/ScheduledTasks/ScheduledTasks.psd1');
    $t=Get-ScheduledTask -TaskPath '\\' -TaskName ${quote(name)} -ErrorAction Stop;
    if($t.Description -ne ${quote(`CodeNomad OpenCode supervision v1 key=${key} root=${directory}`)} -or
      $t.Actions.Count -ne 1 -or $t.Actions[0].Execute -ne ${quote(runtime.powershell)} -or
      $t.Actions[0].Arguments -ne ${quote(args)} -or $t.Actions[0].WorkingDirectory -ne ${quote(directory)} -or
      $t.State -eq 'Disabled'){throw 'ownership'};
    $sid=[string]$t.Principal.UserId; if($sid -notmatch '^S-1-'){
      $sid=[Security.Principal.NTAccount]::new($sid).Translate([Security.Principal.SecurityIdentifier]).Value};
    if($sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'principal'};
    $text=Export-ScheduledTask -InputObject $t; if($text.Length -gt 32768){throw 'bounded'};
    $x=[xml]$text; if($x.Task.Settings.MultipleInstancesPolicy -ne 'Queue' -or
      $x.Task.Settings.ExecutionTimeLimit -ne 'PT10S' -or $x.Task.Settings.Enabled -eq 'false' -or
      $x.Task.Triggers.TimeTrigger.Enabled -eq 'false' -or $x.Task.Triggers.TimeTrigger.EndBoundary -or
      $x.Task.Triggers.TimeTrigger.Repetition.Interval -ne 'PT1M' -or
      $x.Task.Triggers.TimeTrigger.Repetition.Duration){throw 'policy'};
    $i=Get-ScheduledTaskInfo -InputObject $t; if($i.NextRunTime -le (Get-Date)){throw 'date'};
    $i.NextRunTime.ToUniversalTime().ToString('o')`
  const text = await new Promise<string>((resolve, reject) => execFile(runtime.powershell,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 5000, maxBuffer: 4096, env: { SystemRoot: runtime.environment.SystemRoot,
      WINDIR: runtime.environment.WINDIR } },
    (error, stdout) => error ? reject(new Error("supervision-recovery-unknown")) : resolve(stdout.trim())))
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/.test(text) ? new Date(text).toISOString() : undefined
}
