import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, link, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { privateStorage, type StoragePolicy } from "./storage"
import { verifyWindowsPrivateStorage } from "./windows-storage"
import { SupervisionError } from "./service-supervision-contract"

export const supervisionArtifactPolicy: StoragePolicy = {
  async verify(file, directory) {
    const stat = await lstat(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1))
      throw new SupervisionError("unsafe-storage")
    await verifyWindowsPrivateStorage(file, directory, 256 * 1024 * 1024)
  },
}

/** Creates only a new private leaf; existing directories/ACLs are verified and
 * preserved. Production always checks the complete ancestor chain afterward. */
export async function prepareSupervisionRoot(root: string, powershell: string, policy: StoragePolicy = privateStorage) {
  if (!path.win32.isAbsolute(root) || /[\x00-\x1f]/.test(root)) throw new SupervisionError("unsafe-storage")
  try { await lstat(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const literal = root.replaceAll("'", "''")
    const script = `$ErrorActionPreference='Stop'; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User;
      $a=[Security.AccessControl.DirectorySecurity]::new(); $a.SetOwner($u); $a.SetAccessRuleProtection($true,$false);
      foreach($s in @($u,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
        $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
      }; [void][IO.Directory]::CreateDirectory('${literal}',$a)`
    await new Promise<void>((resolve, reject) => execFile(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 5000, maxBuffer: 4096 },
    error => error ? reject(new SupervisionError("unsafe-storage")) : resolve()))
  }
  await policy.verify(root, true)
}

/** Immutable content-addressed copies outlive backend/package replacement.
 * A published descriptor pins its version; another profile never rewrites it. */
export async function provisionSupervisionRuntime(directory: string, policy: StoragePolicy = supervisionArtifactPolicy,
  sources = { node: process.execPath,
    script: fileURLToPath(new URL("../../dist/host-lifetime/service-supervision-windows.ps1", import.meta.url)),
    probe: fileURLToPath(new URL("../../dist/host-lifetime/service-supervision-probe.cjs", import.meta.url)) }) {
  const destination = path.join(directory, "runtime")
  await mkdir(destination, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error })
  await policy.verify(destination, true)
  const result = {} as Record<keyof typeof sources, string>
  for (const key of ["node", "script", "probe"] as const) {
    const source = sources[key], stat = await lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new SupervisionError("unsafe-storage")
    const bytes = await readFile(source)
    if (bytes.length !== stat.size) throw new SupervisionError("conflict")
    const hash = createHash("sha256").update(bytes).digest("hex")
    const file = path.join(destination, `${hash}${key === "node" ? ".exe" : key === "script" ? ".ps1" : ".cjs"}`)
    try { await lstat(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const temporary = path.join(destination, `${randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, "wx", 0o600)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        await policy.verify(temporary, false)
        await link(temporary, file).catch(error => { if (error.code !== "EEXIST") throw error })
      } finally { await rm(temporary, { force: true }) }
    }
    await policy.verify(file, false)
    if (createHash("sha256").update(await readFile(file)).digest("hex") !== hash) throw new SupervisionError("conflict")
    result[key] = file
  }
  return result
}
