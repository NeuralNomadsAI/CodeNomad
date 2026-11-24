# A real OLE FileDrop source for this checkout's isolated release fixture.
param([Parameter(Mandatory=$true)][int]$FixtureProcessId)
$ErrorActionPreference = 'Stop'
$fixture = Get-Process -Id $FixtureProcessId
$expected = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../target/release/codenomad-webkit-capabilities-fixture.exe'))
if ($fixture.Path -ne $expected) { throw 'Expected this checkout''s isolated fixture' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$file = (Resolve-Path (Join-Path $PSScriptRoot 'drop-fixture.txt')).Path
$form = New-Object Windows.Forms.Form
$form.Text = 'Capabilities file source'
$form.Size = New-Object Drawing.Size 240,110
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point ([Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Right - 260),100
$form.TopMost = $true
$button = New-Object Windows.Forms.Button
$button.Dock = 'Fill'
$button.Text = 'Drag fixture file'
$button.Add_MouseDown({
  $data = New-Object Windows.Forms.DataObject
  $data.SetData([Windows.Forms.DataFormats]::FileDrop, [string[]]@($file))
  $effect = $button.DoDragDrop($data, [Windows.Forms.DragDropEffects]::Copy)
  Write-Output "drag-end $effect"
})
$form.Controls.Add($button)
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class SourceWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); }
'@
$form.Show()
$null = [SourceWindow]::ShowWindow($form.Handle, 5)
[Windows.Forms.Application]::Run($form)
