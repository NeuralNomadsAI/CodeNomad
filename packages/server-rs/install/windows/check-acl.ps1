# check-acl.ps1 -Root <folder>: audit E1 regression check. Prints one JSON line:
# the problems (another owner, a link, an allow entry for any SID but this user,
# SYSTEM or OWNER RIGHTS) below Root, bin, releases, run, opencode and config,
# and the distinct SIDs allowed on each top folder. Exit 1 when there is a problem.
param([Parameter(Mandatory)][string]$Root)
. (Join-Path $PSScriptRoot 'common.ps1')
$L = Get-Layout $Root
$problems = @(); $sids = [ordered]@{}
foreach ($dir in $L.Root, $L.Bin, $L.Releases, $L.Run, $L.OpenCode, $L.Config) {
  if (!(Test-Path -LiteralPath $dir)) { $problems += "$dir is missing"; continue }
  $deep = $dir -ne $L.Root
  foreach ($item in @($dir) + @(Get-ChildItem -LiteralPath $dir -Recurse:$deep -Force -ErrorAction SilentlyContinue | ForEach-Object FullName)) {
    $problems += @(Test-Private $item)
  }
  $acl = [IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($dir))
  $sids[(Split-Path -Leaf $dir)] = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { "$($_.AccessControlType):$($_.IdentityReference)" } | Sort-Object -Unique)
}
[ordered]@{ private = !$problems; user = "$script:Me"; problems = @($problems | Select-Object -First 20); sids = $sids } | ConvertTo-Json -Compress -Depth 4
exit [int][bool]$problems
