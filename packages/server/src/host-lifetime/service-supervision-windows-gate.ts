import { spawn } from "node:child_process"
import path from "node:path"
import { SupervisionError, SUPERVISION_MANIFEST_BYTES } from "./service-supervision-contract"

/** The process that holds FileShare.None also performs the atomic replacement.
 * Killing it releases the handle and prevents a late Node callback from writing
 * outside exclusion. Main/Recovery use the same admission.lock for Start. The
 * caller verifies the private directory and manifest before this transaction. */
export async function mutateWindowsSupervisionFile(file: string,
  update: (bytes: string | null) => Promise<string>): Promise<void> {
  if (process.platform !== "win32" || !/^[A-Za-z]:\\/.test(file) || /[\x00-\x1f]/.test(file)
    || path.win32.normalize(file) !== file || file.slice(2).includes(":")) throw new SupervisionError("unsafe-storage")
  const script = `$ErrorActionPreference='Stop'; $h=$null; $tmp=$null
    $file='${file.replace(/'/g, "''")}'; $gate=[IO.Path]::Combine([IO.Path]::GetDirectoryName($file),'admission.lock')
    try { $h=[IO.File]::Open($gate,'OpenOrCreate','ReadWrite','None') }
    catch [IO.IOException] { [Console]::Out.WriteLine('BUSY'); exit 0 }
    catch { exit 1 }
    try {
      $before=$null
      if ([IO.File]::Exists($file)) {
        if ((Get-Item -LiteralPath $file).Length -gt ${SUPERVISION_MANIFEST_BYTES}) { throw 'bounded' }
        $before=[IO.File]::ReadAllBytes($file)
        if ($before.Length -gt ${SUPERVISION_MANIFEST_BYTES}) { throw 'bounded' }
      }
      [Console]::Out.WriteLine('READY:'+$(if ($null -eq $before) { '-' } else { [Convert]::ToBase64String($before) }))
      [Console]::Out.Flush()
      $line=[Console]::In.ReadLine()
      if ($null -eq $line -or $line.Length -gt 90000) { throw 'cancelled' }
      $bytes=[Convert]::FromBase64String($line)
      if ($bytes.Length -gt ${SUPERVISION_MANIFEST_BYTES}) { throw 'bounded' }
      $tmp=[IO.Path]::Combine([IO.Path]::GetDirectoryName($file),[guid]::NewGuid().ToString()+'.tmp')
      $out=[IO.File]::Open($tmp,'CreateNew','Write','None')
      try { $out.Write($bytes,0,$bytes.Length); $out.Flush($true) } finally { $out.Dispose() }
      if ($null -eq $before) { [IO.File]::Move($tmp,$file) } else { [IO.File]::Replace($tmp,$file,[NullString]::Value) }
      [Console]::Out.WriteLine('COMMITTED')
    } catch { exit 1 }
    finally { if ($tmp -and [IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }; $h.Dispose() }`
  const executable = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] })
  const exited = new Promise<number | null>(resolve => {
    child.once("exit", resolve); child.once("error", () => resolve(null))
  })
  // A broken pipe is a failed transaction, never an unhandled process error.
  child.stdin.on("error", () => {})
  let output = "", committed = false
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new SupervisionError("unsafe-storage")))
      child.once("exit", () => { if (!committed) reject(new SupervisionError("busy")) })
      let requested = false
      child.stdout.on("data", bytes => {
        output += bytes.toString("utf8")
        if (output.length > 100_000) { reject(new SupervisionError("invalid")); child.kill(); return }
        const lines = output.split(/\r?\n/)
        if (!requested && lines.length > 1) {
          requested = true
          if (!lines[0].startsWith("READY:")) { reject(new SupervisionError("busy")); return }
          const data = lines[0].slice(6)
          void update(data === "-" ? null : Buffer.from(data, "base64").toString("utf8")).then(next => {
            if (child.exitCode !== null || child.killed) return
            if (Buffer.byteLength(next) > SUPERVISION_MANIFEST_BYTES) throw new SupervisionError("invalid")
            child.stdin.end(Buffer.from(next).toString("base64") + "\n")
          }).catch(reject)
        }
        if (lines.includes("COMMITTED")) { committed = true; resolve() }
      })
    })
    if (await exited !== 0) throw new SupervisionError("busy")
  } finally {
    child.stdin.end()
    if (!committed) child.kill()
    await exited
    clearTimeout(timer)
  }
}
