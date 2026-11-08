# Run against a fresh isolated release fixture and its loopback acceptance page.
param([Parameter(Mandatory=$true)][int]$FixtureProcessId,
      [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
      [switch]$CloseOnly)
$ErrorActionPreference = 'Stop'
$driver = Join-Path $PSScriptRoot 'windows-ui.ps1'
$null = New-Item -ItemType Directory -Path $EvidenceDirectory
function Read-Fixture([switch]$Popup) { (& $driver -FixtureProcessId $FixtureProcessId -Popup:$Popup) -join "`n" }
function Save-State([string]$Name,[switch]$Popup) { Read-Fixture -Popup:$Popup | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory "$Name.txt") }
function Wait-State([scriptblock]$Predicate,[switch]$Popup) {
 $deadline = [DateTime]::UtcNow.AddSeconds(10)
 do {
  try { $text = Read-Fixture -Popup:$Popup }
  catch {
   if (!$Popup -or $_.Exception.Message -ne 'Expected one owned fixture popup') { throw }
   [Threading.Thread]::Sleep(100)
   continue
  }
  if (& $Predicate $text) { return }
  [Threading.Thread]::Sleep(100)
 } while ([DateTime]::UtcNow -lt $deadline)
 throw 'Expected native fixture state did not appear'
}
function Page-Action([string]$Name) {
 if($CloseOnly){ & $driver -FixtureProcessId $FixtureProcessId -Popup -Invoke $Name }
 else { & $driver -FixtureProcessId $FixtureProcessId -Popup -Invoke $Name -NativePointer -Activate }
}
function Open-TestPopup {
 if($CloseOnly){ & $driver -FixtureProcessId $FixtureProcessId -Invoke 'Close-test popup' }
 else { & $driver -FixtureProcessId $FixtureProcessId -Invoke 'Close-test popup' -NativePointer -Activate }
}
function Dialog-Action([string]$Name) { & $driver -FixtureProcessId $FixtureProcessId -Invoke $Name }
function Wait-LeaveDialog { Wait-State { param($t) $t.Contains('WINDOW | Quitter le site') } }
function Wait-ReloadDialog { Wait-State { param($t) $t.Contains('WINDOW | Recharger le site') } }
function Cancel-Dialog {
 Dialog-Action 'Annuler'
 Wait-State { param($t) !$t.Contains('WINDOW | Quitter le site') -and !$t.Contains('WINDOW | Recharger le site') }
}
function Wait-FreshPage { Wait-State -Popup { param($t) $t.Contains('isolation:') -and !$t.Contains('beforeunload: armed') } }
function Close-Popup {
 . $driver -FixtureProcessId $FixtureProcessId -Popup | Out-Null
 $handle = [IntPtr]$roots[0].Current.NativeWindowHandle
 if ($handle -eq [IntPtr]::Zero) { throw 'Owned fixture popup has no HWND' }
 if (!('BeforeUnloadCloseInput' -as [type])) { Add-Type @'
using System; using System.Runtime.InteropServices;
public static class BeforeUnloadCloseInput { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); }
'@ }
 if (![BeforeUnloadCloseInput]::PostMessage($handle,16,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'Owned popup close input refused' }
}
function Wait-PopupGone { Wait-State { param($t) !$t.Contains('ControlType.Window | http://127.0.0.1:18741') -and !$t.Contains('WINDOW | http://127.0.0.1:18741') } }

if ((Read-Fixture).Contains('beforeunload: armed')) { throw 'Use a fresh fixture' }
Open-TestPopup
Wait-FreshPage
Page-Action 'Override window.close'
Wait-State -Popup { param($t) $t.Contains('close-override: ()=>{}') }
Save-State 'close-override-no-unload' -Popup
Close-Popup
Wait-PopupGone
Save-State 'close-override-no-unload-complete'
Open-TestPopup
Wait-FreshPage
if (!$CloseOnly) {
Page-Action 'Arm beforeunload'
Page-Action 'Navigate'
Wait-LeaveDialog
Save-State 'navigation-confirm'
Cancel-Dialog
Wait-State -Popup { param($t) $t.Contains('beforeunload: armed') }
Save-State 'navigation-stay' -Popup

Page-Action 'Reload page'
Wait-ReloadDialog
Save-State 'reload-confirm'
Cancel-Dialog
Save-State 'reload-stay' -Popup
if (!(Read-Fixture -Popup).Contains('beforeunload: armed')) { throw 'Stay discarded the page' }
Page-Action 'Reload page'
Wait-ReloadDialog
Dialog-Action 'Recharger'
Wait-FreshPage
Save-State 'reload-leave' -Popup

Page-Action 'Arm beforeunload'
Page-Action 'Navigate'
Wait-LeaveDialog
Dialog-Action 'Quitter'
Wait-FreshPage
Save-State 'navigation-leave' -Popup
}

Page-Action 'Override window.close'
Wait-State -Popup { param($t) $t.Contains('close-override: ()=>{}') }
Save-State 'close-override' -Popup
Page-Action 'Arm beforeunload'
Wait-State -Popup { param($t) $t.Contains('beforeunload: armed') -and $t.Contains('activation: true') }
Close-Popup
Wait-LeaveDialog
Save-State 'close-confirm'
Cancel-Dialog
Wait-State -Popup { param($t) $t.Contains('beforeunload: armed') }
Save-State 'close-stay' -Popup
Close-Popup
Wait-LeaveDialog
Dialog-Action 'Quitter'
Wait-PopupGone
Save-State 'close-leave'
$cases = if($CloseOnly){'popup-close'}else{'navigation/reload/popup-close'}
Write-Output "PASS native beforeunload ${cases}: Stay preserves and Leave completes even after window.close redefinition; unarmed overridden popup closes too; evidence=$EvidenceDirectory"
