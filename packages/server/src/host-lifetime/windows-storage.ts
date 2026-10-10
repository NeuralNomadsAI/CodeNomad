import { execFile } from "node:child_process"
import path from "node:path"
import { HostError, MAX_BYTES } from "./protocol"
import type { StoragePolicy } from "./storage"

const EVIDENCE_BYTES = 64 * 1024
const MAX_ANCESTORS = 64
const MAX_ACES = 512
const SYSTEM = "S-1-5-18"
const ADMINISTRATORS = "S-1-5-32-544"
const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
const FULL_CONTROL = 0x1f01ff
// Ancestors can grant read/create-sibling access, but not replacement or control.
const REPLACE_OR_CONTROL = 0xd0040 // DELETE, DELETE_CHILD, WRITE_DAC, WRITE_OWNER

function unknown(): never { throw new HostError("windows-storage-evidence-unknown") }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown()
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(result, key))) return unknown()
  return result
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) return unknown()
  return value
}
function sid(value: unknown): string {
  if (typeof value !== "string" || value.length > 184 || !/^S-1-(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*)){1,15}$/.test(value)) return unknown()
  const parts = value.split("-").slice(2)
  if (BigInt(parts[0]) > 0xffffffffffffn || parts.slice(1).some(part => BigInt(part) > 0xffffffffn)) return unknown()
  return value
}
function effectiveRights(raw: unknown): number {
  const rights = integer(raw, 0xffffffff)
  if ((rights & ~((FULL_CONTROL | 0xf0000000) >>> 0)) !== 0) return unknown()
  let mapped = rights & FULL_CONTROL
  if (rights & 0x10000000) mapped |= FULL_CONTROL
  if (rights & 0x80000000) mapped |= 0x120089
  if (rights & 0x40000000) mapped |= 0x120116
  if (rights & 0x20000000) mapped |= 0x1200a0
  return mapped
}

/** Pure validator for bounded native evidence, not an assertion supplied by env/token.
 * No denial ACE is used to excuse an otherwise foreign Allow ACE. Unknown ACE kinds
 * (including callback/object ACEs), null DACLs and noncanonical ACLs fail closed. */
export function verifyWindowsStorageEvidence(raw: string, directory: boolean, ancestorCount: number): void {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > EVIDENCE_BYTES
    || !Number.isSafeInteger(ancestorCount) || ancestorCount < 0 || ancestorCount > MAX_ANCESTORS) return unknown()
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return unknown() }
  const evidence = record(parsed, ["v", "currentSid", "entries"])
  const current = sid(evidence.currentSid)
  // Only an actual local/domain account or SYSTEM may be the execution principal.
  if (evidence.v !== 1 || (current !== SYSTEM && !/^S-1-5-21-\d+-\d+-\d+-[1-9]\d*$/.test(current))
    || !Array.isArray(evidence.entries) || evidence.entries.length !== ancestorCount + 1) return unknown()
  let aceCount = 0
  for (let index = 0; index < evidence.entries.length; index++) {
    const entry = record(evidence.entries[index], ["attributes", "length", "owner", "daclPresent", "canonical", "aces"])
    const attributes = integer(entry.attributes, 0xffff)
    const isDirectory = index > 0 || directory
    if ((attributes & 0x400) !== 0 || Boolean(attributes & 0x10) !== isDirectory)
      throw new HostError(index ? "unsafe-storage-ancestor" : "unsafe-storage-type")
    const length = integer(entry.length, Number.MAX_SAFE_INTEGER)
    if ((isDirectory && length !== 0) || (!isDirectory && length > MAX_BYTES)) throw new HostError("unsafe-storage-read")
    const owner = sid(entry.owner)
    const trusted = new Set(index ? [current, SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER] : [current, SYSTEM])
    if (!trusted.has(owner)) throw new HostError(index ? "unsafe-storage-ancestor" : "unsafe-storage-permissions")
    if (entry.daclPresent !== true || entry.canonical !== true || !Array.isArray(entry.aces)
      || entry.aces.length > 128 || (aceCount += entry.aces.length) > MAX_ACES) return unknown()
    for (const value of entry.aces) {
      const ace = record(value, ["type", "sid", "rights", "flags"])
      if (ace.type !== 0 && ace.type !== 1) return unknown()
      const principal = sid(ace.sid)
      const flags = integer(ace.flags, 31)
      if ((flags & 8) && !(flags & 3)) return unknown()
      const rights = effectiveRights(ace.rights)
      if (ace.type !== 0 || rights === 0 || trusted.has(principal)) continue
      // InheritOnly is ineffective on a file. On a private directory it could
      // expose a newly created child before that child's verification, so refuse.
      if ((flags & 8) && (index > 0 || !directory)) continue
      if (index === 0 || (rights & REPLACE_OR_CONTROL))
        throw new HostError(index ? "unsafe-storage-ancestor" : "unsafe-storage-permissions")
    }
  }
}

/** Local absolute paths only; no remote share, device namespace or alternate stream.
 * LiteralPath is single-quoted then the entire fixed script is UTF-16 encoded by
 * execFile. Apostrophes, dollar signs and metacharacters are never executable. */
export function windowsStorageScript(file: string): { script: string; ancestorCount: number } {
  if (typeof file !== "string" || file.length > 4096 || /[\x00-\x1f]/.test(file)
    || file.split(/[\\/]/).some(segment => segment === "." || segment === "..")) return unknown()
  const normalized = path.win32.normalize(file)
  if (!/^[A-Za-z]:\\/.test(normalized) || normalized.slice(2).includes(":")
    || normalized.split("\\").slice(1).some(segment => /[. ]$/.test(segment))) return unknown()
  const paths = [normalized]
  while (true) {
    const parent = path.win32.dirname(paths[paths.length - 1])
    if (parent === paths[paths.length - 1]) break
    if (paths.length > MAX_ANCESTORS) return unknown()
    paths.push(parent)
  }
  const literals = paths.map(item => `'${item.replace(/'/g, "''")}'`).join(",")
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $entries = @()
  $total = 0
  foreach ($literal in @(${literals})) {
    $item = Get-Item -LiteralPath $literal -Force -ErrorAction Stop
    $attributes = [int]$item.Attributes
    if (($attributes -band 1024) -ne 0) { throw 'reparse' }
    $acl = Get-Acl -LiteralPath $literal -ErrorAction Stop
    $bytes = $acl.GetSecurityDescriptorBinaryForm()
    if ($bytes.Length -gt 16384) { throw 'bounded' }
    $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($bytes, 0)
    if ($null -eq $descriptor.DiscretionaryAcl -or $descriptor.DiscretionaryAcl.Count -gt 128) { throw 'dacl' }
    $aces = @()
    foreach ($ace in $descriptor.DiscretionaryAcl) {
      $total++
      if ($total -gt ${MAX_ACES} -or $ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback) { throw 'ace' }
      $rights = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$ace.AccessMask), 0)
      $aces += @{ type = [int]$ace.AceType; sid = $ace.SecurityIdentifier.Value; rights = $rights; flags = [int]$ace.AceFlags }
    }
    $length = 0
    if (-not $item.PSIsContainer) { $length = $item.Length }
    $entries += @{ attributes = $attributes; length = $length; owner = $descriptor.Owner.Value;
      daclPresent = (($descriptor.ControlFlags -band 4) -ne 0); canonical = $acl.AreAccessRulesCanonical; aces = @($aces) }
  }
  $result = @{ v = 1; currentSid = $current; entries = @($entries) } | ConvertTo-Json -Depth 6 -Compress
  if ([Text.Encoding]::UTF8.GetByteCount($result) -gt ${EVIDENCE_BYTES}) { throw 'bounded' }
  [Console]::Out.Write($result)
} catch { [Console]::Out.Write('UNKNOWN'); exit 1 }
`
  // Windows' command-line limit also bounds encoded script/path expansion.
  if (Buffer.byteLength(script, "utf16le") > 20_000) return unknown()
  return { script, ancestorCount: paths.length - 1 }
}

export const windowsPrivateStorage: StoragePolicy = {
  async verify(file, directory) {
    if (process.platform !== "win32") throw new HostError("windows-storage-evidence-unknown")
    const { script, ancestorCount } = windowsStorageScript(file)
    const executable = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
    const raw = await new Promise<string>((resolve, reject) => {
      execFile(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { windowsHide: true, timeout: 5_000, maxBuffer: EVIDENCE_BYTES, encoding: "utf8",
          env: { ...process.env, PSModulePath: path.join(path.dirname(executable), "Modules") } }, (error, stdout, stderr) => {
          // Do not propagate native errors, paths, stdout or stderr to logs/callers.
          if (error || stderr.trim()) reject(new HostError("windows-storage-evidence-unknown"))
          else resolve(stdout)
        })
    }).catch(() => unknown())
    verifyWindowsStorageEvidence(raw, directory, ancestorCount)
  },
}
