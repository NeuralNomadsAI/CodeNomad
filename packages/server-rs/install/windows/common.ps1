# Shared layout for the CodeNomad Rust per-user background service. Dot-sourced.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

function Get-Layout([string]$Root) {
  $Root = [IO.Path]::GetFullPath($Root)
  $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant()))).Substring(0, 12).ToLowerInvariant()
  [pscustomobject]@{
    Root = $Root; Releases = Join-Path $Root 'releases'; Config = Join-Path $Root 'config'
    State = Join-Path $Root 'state'; Run = Join-Path $Root 'run'; Bin = Join-Path $Root 'bin'
    OpenCode = Join-Path $Root 'opencode'; Task = "CodeNomadRs-$hash"; Mutex = "Local\CodeNomadRs-$hash"
  }
}

function Write-Log([string]$Message) { [Console]::Error.WriteLine("$([DateTime]::UtcNow.ToString('s'))Z $Message") }

# Atomic text replacement (pointers, env files).
function Set-Text([string]$Path, [string]$Text) {
  $temporary = "$Path.$([guid]::NewGuid()).tmp"
  [IO.File]::WriteAllText($temporary, $Text)
  [IO.File]::Move($temporary, $Path, $true)  # MoveFileEx(REPLACE_EXISTING): readers see old or new
}

function Read-Env([string]$Path) {
  $values = [ordered]@{}
  if (Test-Path $Path) {
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
      if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
    }
  }
  $values
}
function Write-Env([string]$Path, $Values) {
  Set-Text $Path ((($Values.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n") + "`n")
}

$script:Me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$script:System = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')

function New-PrivateAcl {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($sid in $script:Me, $script:System) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')))
  }
  $acl
}

# Problems that let another local account change this item: a link, another
# owner, or any allow entry for a SID other than this user and SYSTEM.
function Test-Private([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (!$item) { return @() }  # vanished meanwhile (pid and request files)
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return @("$Path is a reparse point") }
  $sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
  $acl = if ($item -is [IO.DirectoryInfo]) { [IO.FileSystemAclExtensions]::GetAccessControl($item, $sections) } else { [IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]$item, $sections) }
  $problems = @()
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  if ($owner -ne $script:Me) { $problems += "$Path is owned by $owner" }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    # OWNER RIGHTS (S-1-3-4, the Rust private folders) is this user once the owner is.
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference -ne $script:Me -and $rule.IdentityReference -ne $script:System -and "$($rule.IdentityReference)" -ne 'S-1-3-4') {
      $problems += "$Path grants $($rule.FileSystemRights) to $($rule.IdentityReference)"
    }
  }
  $problems
}

# E1: the whole root is private before anything is created in it. Refuses a root
# that is a link, belongs to another account, cannot be restricted, or whose
# parent lets other accounts replace it.
function Initialize-PrivateRoot([string]$Root) {
  $parent = Split-Path -Parent $Root
  if (!$parent -or !(Test-Path -LiteralPath $parent -PathType Container)) { throw "parent of $Root must exist" }
  $trusted = @($script:Me, $script:System, 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $replace = [Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
  foreach ($rule in [IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($parent)).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and "$($rule.IdentityReference)" -notin $trusted -and ($rule.FileSystemRights -band $replace)) {
      throw "refused: $parent lets $($rule.IdentityReference) replace $Root"
    }
  }
  if (Test-Path -LiteralPath $Root) {
    $item = Get-Item -LiteralPath $Root -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "refused: $Root is a reparse point" }
    $owner = [IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]$item, 'Owner').GetOwner([Security.Principal.SecurityIdentifier])
    if ($owner -ne $script:Me) { throw "refused: $Root is owned by $owner" }
    try { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, (New-PrivateAcl)) }
    catch { throw "refused: the ACL of $Root cannot be restricted ($($_.Exception.Message))" }
  } else {
    # Created with its final DACL: never visible with inherited rights.
    [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($Root), (New-PrivateAcl)) | Out-Null
  }
  $problems = Test-Private $Root
  if ($problems) { throw "refused: $($problems -join '; ')" }
}

# Every item below the executable and secret folders must be private; inherited
# foreign entries left by an older install are reset once to the root's rules.
function Assert-PrivateTree($Layout) {
  $problems = @()
  # The daemon profile under state may legitimately hold links (package caches): only its top is checked.
  foreach ($dir in $Layout.Bin, $Layout.Releases, $Layout.Run, $Layout.OpenCode, $Layout.Config, $Layout.State) {
    if (!(Test-Path -LiteralPath $dir)) { continue }
    $deep = $dir -ne $Layout.State
    $items = @($dir) + @(Get-ChildItem -LiteralPath $dir -Recurse:$deep -Force -ErrorAction SilentlyContinue | Where-Object { $deep -or $_.Name -ne 'opencode' } | ForEach-Object FullName)
    $bad = @($items | Where-Object { Test-Private $_ })
    if ($bad) {
      & icacls $dir /reset /T /C /Q | Out-Null
      $problems += @($items | ForEach-Object { Test-Private $_ })
    }
  }
  $problems += @(Test-Private $Layout.Root)
  if ($problems) { throw "refused: $(($problems | Select-Object -First 5) -join '; ')" }
}

# Owner and SYSTEM only, not inherited (same rule as the Rust private folders).
function Protect-Folder([string]$Path) {
  New-Item -ItemType Directory -Force $Path | Out-Null
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($sid in [Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18')) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')))
  }
  # Writes the DACL only (Set-Acl would also need SeSecurityPrivilege for the SACL).
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), $acl)
}

# Release trust root: bin\cnrs-release.exe and the trust state (pinned key, highest
# accepted serial, accepted releases) in config\release-trust and its copy state\release-trust.
function Get-Trust($Layout) { @((Join-Path $Layout.Config 'release-trust'), (Join-Path $Layout.State 'release-trust')) }
function Invoke-Trust($Layout, [string]$Command, [string]$Dir, [switch]$NoReleases) {
  $verifier = Join-Path $Layout.Bin 'cnrs-release.exe'
  if (!(Test-Path $verifier)) { throw 'release verifier missing: run install.ps1' }
  $argv = @($Command, $Dir) + (Get-Trust $Layout) + $(if ($NoReleases) { @() } else { @($Layout.Releases) })
  $out = "$(& $verifier @argv 2>&1)".Trim()
  if ($LASTEXITCODE -or $out -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') { throw "release refused: $Dir ($out)" }
  $out
}
# Signature by the pinned key, every file listed and matching, serial above the
# highest accepted one (or the very release that set it).
function Test-Release($Layout, [string]$Dir) { Invoke-Trust $Layout 'admit' $Dir }

# Copy a release beside the others, verify the copy itself before it can run,
# then commit it: serial and announced next key advance in one atomic write of
# each trust copy. An existing copy must be identical; it is committed again
# (an install interrupted before its commit completes).
function Install-Release($Layout, [string]$Dir) {
  $version = Test-Release $Layout $Dir
  $dest = Join-Path $Layout.Releases $version
  New-Item -ItemType Directory -Force $Layout.Releases | Out-Null
  if (Test-Path $dest) {
    if ([IO.File]::ReadAllText((Join-Path $Dir 'SHA256SUMS')) -ne [IO.File]::ReadAllText((Join-Path $dest 'SHA256SUMS'))) { throw "release $version already installed with other contents" }
  } else {
    Remove-Item -Recurse -Force "$dest.tmp" -ErrorAction SilentlyContinue
    Copy-Item -Recurse $Dir "$dest.tmp"
    # F7: the copy itself is verified (signature, every file listed) before it can run.
    $staged = try { Test-Release $Layout "$dest.tmp" } catch { Remove-Item -Recurse -Force "$dest.tmp"; throw }
    if ($staged -ne $version) { Remove-Item -Recurse -Force "$dest.tmp"; throw "staged copy of $version differs" }
    Rename-Item "$dest.tmp" $version
    Write-Log "staged release $version"
  }
  if ((Invoke-Trust $Layout 'commit' $dest) -ne $version) { throw "commit of $version failed" }
  $version
}
# Local rollback target: accepted on this installation and unchanged since.
function Test-StagedRelease($Layout, [string]$Dir) { Invoke-Trust $Layout 'staged' $Dir -NoReleases }
function Get-Pointer($Layout, [string]$Name) {
  $file = Join-Path $Layout.Root "$Name.txt"
  if (Test-Path $file) { ([IO.File]::ReadAllText($file)).Trim() } else { $null }
}
function Set-Pointer($Layout, [string]$Name, [string]$Version) { Set-Text (Join-Path $Layout.Root "$Name.txt") $Version }

function Get-Pid($Layout, [string]$Name) {
  $file = Join-Path $Layout.Run "$Name.pid"
  if (Test-Path $file) { [int]([IO.File]::ReadAllText($file).Trim()) } else { 0 }
}

# Ask the supervisor to restart the backend and wait until a new process runs.
function Request-Restart($Layout, [int]$TimeoutSeconds = 20) {
  $before = Get-Pid $Layout 'rust'
  Set-Text (Join-Path $Layout.Run 'restart.request') ''
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if (!(Test-Path (Join-Path $Layout.Run 'restart.request')) -and (Get-Pid $Layout 'rust') -ne $before) { return }
  }
  throw 'supervisor did not restart the backend'
}
