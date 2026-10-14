import { execFileSync } from "node:child_process"
import { lstatSync } from "node:fs"
import path from "node:path"
import { HostError } from "./protocol"
import { windowsStorageScript, verifyWindowsStorageEvidence } from "./windows-storage"

/** Existing owner/DACL evaluator, synchronously reobserved at final publication. */
export function verifyPrivateSync(file: string, directory: boolean): void {
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new HostError("unsafe-storage")
    if (process.platform === "win32") {
      const { script, ancestorCount } = windowsStorageScript(file)
      const executable = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
      const raw = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024, encoding: "utf8",
        env: { ...process.env, PSModulePath: path.join(path.dirname(executable), "Modules") },
      })
      verifyWindowsStorageEvidence(raw, directory, ancestorCount)
    } else if (!process.getuid || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new HostError("unsafe-storage")
  } catch { throw new HostError("private-storage-unavailable") }
}
