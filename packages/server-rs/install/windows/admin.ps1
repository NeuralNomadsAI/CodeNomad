# admin.ps1 -Root <folder> -Method <GET|POST|DELETE> -Path <route> [-Body <json>]
# Authenticated loopback administration request; prints the status, then the body.
param([Parameter(Mandatory)][string]$Root, [string]$Method = 'GET', [Parameter(Mandatory)][string]$Path, [string]$Body = '')
. (Join-Path $PSScriptRoot 'common.ps1')
$L = Get-Layout $Root
$base = "http://127.0.0.1:$((Read-Env (Join-Path $L.Config 'install.conf'))['PORT'])"
$password = (Read-Env (Join-Path $L.Config 'codenomad-rs.env'))['CNRS_SERVER_PASSWORD']
Invoke-RestMethod -NoProxy -Method Post "$base/api/auth/login" -ContentType 'application/json' -SessionVariable session `
  -Body (@{ username = 'codenomad'; password = $password } | ConvertTo-Json -Compress) | Out-Null
$request = @{ Method = $Method; Uri = "$base$Path"; WebSession = $session; SkipHttpErrorCheck = $true; NoProxy = $true }
if ($Body) { $request.ContentType = 'application/json'; $request.Body = $Body }
$response = Invoke-WebRequest @request
[int]$response.StatusCode
$response.Content
