import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { HostError, MAX_BYTES } from "./protocol"
import { privateStorage } from "./storage"
import { verifyWindowsStorageEvidence, windowsPrivateStorage, windowsStorageScript } from "./windows-storage"

const CURRENT = "S-1-5-21-123-456-789-1001"
const SYSTEM = "S-1-5-18"
const FOREIGN = "S-1-5-21-123-456-789-1002"
const allow = (sid = CURRENT, rights = 0x1f01ff, flags = 0) => ({ type: 0, sid, rights, flags })
const entry = (directory = true) => ({
  attributes: directory ? 16 : 128, length: 0, owner: CURRENT,
  daclPresent: true, canonical: true, aces: [allow(), allow(SYSTEM)],
})
const evidence = (directory = true) => ({ v: 1, currentSid: CURRENT, entries: [entry(directory), entry()] })
type Evidence = ReturnType<typeof evidence>
function verify(value: unknown, directory = true, ancestors = 1): void {
  verifyWindowsStorageEvidence(JSON.stringify(value), directory, ancestors)
}
function rejected(mutator: (value: Evidence) => void, code = "windows-storage-evidence-unknown", directory = true): void {
  const value = evidence(directory)
  mutator(value)
  assert.throws(() => verify(value, directory), (error: unknown) => error instanceof HostError && error.code === code)
}

test("private native owner/DACL evidence accepts only current account and SYSTEM", () => {
  verify(evidence())
  verify(evidence(false), false)
  const inherited = evidence(false)
  inherited.entries[0].aces = [allow(CURRENT, 0x120089, 16), allow(SYSTEM, 0x1f01ff, 16)]
  verify(inherited, false)
  inherited.entries[0].owner = SYSTEM
  verify(inherited, false)
  const system = evidence()
  system.currentSid = SYSTEM
  for (const item of system.entries) { item.owner = SYSTEM; item.aces = [allow(SYSTEM)] }
  verify(system)
})

test("foreign/everyone/group Allow ACEs fail regardless of inheritance or overriding Deny", () => {
  for (const principal of [FOREIGN, "S-1-1-0", "S-1-5-11", "S-1-5-32-544", "S-1-3-0"]) {
    for (const flags of [0, 16, 3, 19]) {
      rejected(value => value.entries[0].aces.push(allow(principal, 1, flags)), "unsafe-storage-permissions")
      rejected(value => value.entries[0].aces.push(allow(principal, 0x10000000, flags)), "unsafe-storage-permissions", false)
    }
  }
  rejected(value => value.entries[0].aces.push({ ...allow(FOREIGN), type: 1 }, allow(FOREIGN)), "unsafe-storage-permissions")
  rejected(value => value.entries[0].aces.push(allow(FOREIGN, 1, 11)), "unsafe-storage-permissions")
  const file = evidence(false)
  file.entries[0].aces.push(allow(FOREIGN, 1, 11)) // InheritOnly cannot expose this file.
  verify(file, false)
  file.entries[0].aces = [{ ...allow(FOREIGN), type: 1 }, allow()]
  verify(file, false)
})

test("trusted ancestors remain directory/non-reparse, and foreign replacement/control is refused", () => {
  const value = evidence()
  value.entries[1].owner = "S-1-5-32-544"
  value.entries[1].aces.push(allow("S-1-1-0", 0x120089), allow("S-1-5-11", 4)) // Read / create siblings.
  value.entries[1].aces.push(allow("S-1-3-0", 0x10000000, 11)) // InheritOnly, not effective on this ancestor.
  verify(value)
  for (const rights of [0x10000, 0x40, 0x40000, 0x80000, 0x10000000]) {
    rejected(item => item.entries[1].aces.push(allow(FOREIGN, rights)), "unsafe-storage-ancestor")
  }
  rejected(item => item.entries[1].owner = FOREIGN, "unsafe-storage-ancestor")
  rejected(item => item.entries[1].attributes |= 1024, "unsafe-storage-ancestor")
  rejected(item => item.entries[1].attributes = 128, "unsafe-storage-ancestor")
  rejected(item => item.entries.pop())
})

test("unknown, malformed, callback/object ACL and SID evidence fails closed", () => {
  for (const principal of ["", "Admin", "S-1-1-0", "S-1-5-32-544", "S-1-5-21-1-2-3-0"]) {
    rejected(value => value.currentSid = principal)
  }
  for (const principal of ["S-1-5-21-01-2-3-1001", "S-1-5-21-4294967296-2-3-1001", "S-1-281474976710656-1", "S-1-5-21-1-2-3-1001;Start-Process", "S-1-5-" + "1-".repeat(16) + "1"]) {
    rejected(value => value.entries[0].owner = principal)
    rejected(value => value.entries[0].aces[0].sid = principal)
  }
  rejected(value => value.entries[0].owner = FOREIGN, "unsafe-storage-permissions")
  rejected(value => value.entries[0].owner = "S-1-5-32-544", "unsafe-storage-permissions")
  for (const kind of [2, 5, 9, -1, 256]) rejected(value => value.entries[0].aces[0].type = kind)
  for (const flags of [-1, 32, 64, 8, 256]) rejected(value => value.entries[0].aces[0].flags = flags)
  for (const rights of [-1, 0x100000000, 0x200, 0.1]) rejected(value => value.entries[0].aces[0].rights = rights)
  rejected(value => value.entries[0].daclPresent = false)
  rejected(value => value.entries[0].canonical = false)
  rejected(value => { (value.entries[0] as any).aces = null })
  rejected(value => { (value.entries[0] as any).attributes = "16" })
  rejected(value => { (value.entries[0] as any).daclPresent = "true" })
  rejected(value => { (value as any).unreadable = true })
  rejected(value => { (value.entries[0].aces[0] as any).condition = "ignored" })
  rejected(value => value.v = 2)
  for (const raw of ["UNKNOWN", "", "null", "{}", "[]", "{", "true", JSON.stringify(evidence()) + "garbage"]) {
    assert.throws(() => verifyWindowsStorageEvidence(raw, true, 1), /windows-storage-evidence-unknown/)
  }
})

test("byte, file length, ACE and ancestor budgets are validated", () => {
  rejected(value => value.entries[0].attributes |= 1024, "unsafe-storage-type")
  rejected(value => value.entries[0].attributes = 128, "unsafe-storage-type")
  rejected(value => value.entries[0].length = MAX_BYTES + 1, "unsafe-storage-read", false)
  rejected(value => value.entries[0].length = 1, "unsafe-storage-read")
  rejected(value => value.entries[0].length = -1)
  rejected(value => value.entries[0].aces = Array.from({ length: 129 }, () => allow()))
  const value = evidence()
  value.entries = Array.from({ length: 5 }, () => ({ ...entry(), aces: Array.from({ length: 128 }, () => allow()) }))
  assert.throws(() => verify(value, true, 4), /windows-storage-evidence-unknown/)
  assert.throws(() => verifyWindowsStorageEvidence(" ".repeat(65537), true, 1), /windows-storage-evidence-unknown/)
  assert.throws(() => verifyWindowsStorageEvidence("é".repeat(32769), true, 1), /windows-storage-evidence-unknown/)
  for (const count of [-1, 65, 0.5, NaN, Infinity]) {
    assert.throws(() => verifyWindowsStorageEvidence(JSON.stringify(evidence()), true, count), /windows-storage-evidence-unknown/)
  }
})

test("LiteralPath quotation and encoded command prevent path injection; remote/device/ADS paths refuse", () => {
  const file = "C:\\private\\x'; $(Write-Output secret); #\\host.json"
  const { script, ancestorCount } = windowsStorageScript(file)
  assert.ok(script.includes("'C:\\private\\x''; $(Write-Output secret); #\\host.json'"))
  assert.ok(script.includes("Get-Acl -LiteralPath $literal -ErrorAction Stop"))
  assert.ok(script.includes("Get-Item -LiteralPath $literal -Force -ErrorAction Stop"))
  assert.equal(ancestorCount, 3)
  assert.equal(Buffer.from(Buffer.from(script, "utf16le").toString("base64"), "base64").toString("utf16le"), script)
  for (const bad of ["relative", "C:relative", "\\\\server\\share\\file", "\\\\?\\C:\\file", "C:\\file:stream", "C:\\name.\\file", "C:\\name \\file", "C:\\file\n", "C:\\file\0", "C:/a/../file", "C:/a/./file", "C:\\" + "a\\".repeat(66), "C:\\" + "a".repeat(4097)]) {
    assert.throws(() => windowsStorageScript(bad), /windows-storage-evidence-unknown/)
  }
  assert.throws(() => windowsStorageScript("C:\\" + ("a".repeat(100) + "\\").repeat(40)), /windows-storage-evidence-unknown/)
})

async function native(script: string, phase: "provision" | "probe" | "unsafe" | "unreadable"): Promise<string> {
  const executable = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
  return new Promise((resolve, reject) => {
    execFile(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 10_000, maxBuffer: 65536, encoding: "utf8",
        env: { ...process.env, PSModulePath: path.join(path.dirname(executable), "Modules") } }, (error, stdout, stderr) => {
        if (error || stderr.trim()) reject(new Error(`private-fixture-native-failure:${phase}:${/^fixture-(identity|acl-create|acl-write)$/.test(stdout.trim()) ? stdout.trim() : "unknown"}`))
        else resolve(stdout)
      })
  })
}

test("native own-temp ACL fixture: current principal/SYSTEM only, inherited files, unsafe ACL and junction refusal", {
  skip: process.platform !== "win32", timeout: 60_000,
}, async () => {
  const temp = process.platform === "win32" ? "C:/Users/Admin/AppData/Local/Temp/opencode" : tmpdir()
  const root = await mkdtemp(path.join(temp, "windows-host-storage-"))
  const quoted = `'${root.replace(/'/g, "''")}'`
  try {
    // This is the ONLY ACL mutation: a directory just created by this fixture.
    // Neither production verification nor the fixture repairs an existing parent.
    await native(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $stage = 'fixture-identity'; try {
      $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $stage = 'fixture-acl-create'
      $acl = [System.Security.AccessControl.DirectorySecurity]::new()
      $acl.SetOwner($user)
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($sid in @($user, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
      }
      $stage = 'fixture-acl-write'
      Set-Acl -LiteralPath ${quoted} -AclObject $acl
    } catch { [Console]::Out.Write($stage); exit 1 }`, "provision")
    const child = path.join(root, "registry")
    await mkdir(child)
    const file = path.join(child, "host'$(not-executed).json")
    await writeFile(file, "{}")
    let qualifiedChain = true
    for (const [target, directory] of [[root, true], [child, true], [file, false]] as const) {
      const probe = windowsStorageScript(target)
      const raw = await native(probe.script, "probe")
      const actual = JSON.parse(raw)
      assert.equal(actual.entries[0].owner, actual.currentSid)
      assert.deepEqual(new Set(actual.entries[0].aces.filter((ace: any) => ace.type === 0).map((ace: any) => ace.sid)), new Set([actual.currentSid, SYSTEM]))
      if (!directory) assert.ok(actual.entries[0].aces.every((ace: any) => ace.flags & 16), "file ACL is genuinely inherited")
      // Qualify the real native leaf independently, even when the CI/agent temp
      // ancestor has broad sandbox mutation rights and cannot qualify as storage.
      verifyWindowsStorageEvidence(JSON.stringify({ ...actual, entries: [actual.entries[0]] }), directory, 0)
      try { verifyWindowsStorageEvidence(raw, directory, probe.ancestorCount) } catch (error) {
        assert.ok(error instanceof HostError && error.code === "unsafe-storage-ancestor")
        qualifiedChain = false
      }
      if (qualifiedChain) await privateStorage.verify(target, directory)
      else await assert.rejects(privateStorage.verify(target, directory), /unsafe-storage-ancestor/)
    }
    // Demonstrate that the entire native adapter does not overclaim safe parents.
    // A broad temp ancestor is an explicit refusal, not a reason to weaken policy.
    await native(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $stage = 'fixture-identity'; try {
      $acl = Get-Acl -LiteralPath ${quoted}
      $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      $stage = 'fixture-acl-create'
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'ReadAndExecute', 'Allow'))
      $stage = 'fixture-acl-write'
      [System.IO.Directory]::SetAccessControl(${quoted}, $acl)
    } catch { [Console]::Out.Write($stage); exit 1 }`, "unsafe")
    await assert.rejects(privateStorage.verify(root, true), /unsafe-storage-permissions/)
    const junction = path.join(root, "junction")
    await symlink(child, junction, "junction")
    await assert.rejects(privateStorage.verify(junction, true), /unsafe-storage-type/)
    await assert.rejects(windowsPrivateStorage.verify(path.join(junction, "host'$(not-executed).json"), false), /windows-storage-evidence-unknown/)
    await assert.rejects(windowsPrivateStorage.verify(path.join(root, "missing"), false), error => {
      assert.ok(error instanceof HostError)
      assert.equal(error.message, "windows-storage-evidence-unknown")
      return true
    })
    const unreadable = path.join(child, "unreadable.json")
    await writeFile(unreadable, "{}")
    await native(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; try {
      $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = [System.Security.AccessControl.FileSecurity]::new()
      $acl.SetOwner($user)
      $acl.SetAccessRuleProtection($true, $false)
      $ownerRights = [System.Security.Principal.SecurityIdentifier]::new('S-1-3-4')
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($ownerRights, 'ReadPermissions', 'Deny'))
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow'))
      [System.IO.File]::SetAccessControl('${unreadable.replace(/'/g, "''")}', $acl)
    } catch { exit 1 }`, "unreadable")
    await assert.rejects(windowsPrivateStorage.verify(unreadable, false), /windows-storage-evidence-unknown/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
