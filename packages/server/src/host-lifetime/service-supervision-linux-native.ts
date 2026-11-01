import { execFile } from "node:child_process"
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { SupervisionError } from "./service-supervision-contract"
import { privateStorage, type StoragePolicy } from "./storage"

export type LinuxCommand = (binary: "/usr/bin/systemctl" | "/usr/bin/loginctl", args: string[]) => Promise<string>
export const linuxCommand: LinuxCommand = (binary, args) => new Promise((resolve, reject) => {
  execFile(binary, args, { env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: process.env.HOME,
    XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid!()}/bus` },
  timeout: 10_000, maxBuffer: 32768 }, (error, stdout) => error ? reject(new SupervisionError("busy")) : resolve(stdout.trim()))
})

/** Check ancestors before creating a child; OS search directories may also hold
 * unrelated apps' public resources, so retain their existing permissions. */
export async function preparePosixSupervisionDirectory(directory: string) {
  let current = path.parse(directory).root
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part)
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error })
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid!()].includes(stat.uid) || (stat.mode & 0o022))
      throw new SupervisionError("unsafe-storage")
  }
}

export async function readLinuxPrivate<T>(file: string, policy: StoragePolicy = privateStorage): Promise<T | undefined> {
  try { await policy.verify(file, false) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
  if ((await lstat(file)).size > 65536) throw new SupervisionError("invalid")
  const bytes = await readFile(file)
  if (bytes.length > 65536) throw new SupervisionError("invalid")
  return JSON.parse(bytes.toString("utf8")) as T
}
export async function writeLinuxPrivate(file: string, value: unknown, policy: StoragePolicy = privateStorage) {
  const bytes = JSON.stringify(value)
  if (Buffer.byteLength(bytes) > 65536) throw new SupervisionError("invalid")
  const temporary = path.join(path.dirname(file), `${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await policy.verify(temporary, false)
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

/** systemd has its own quoting and specifier expansion, independent of a shell. */
export function linuxUnitQuote(value: string): string {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new SupervisionError("invalid")
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => "$$")}"`
}
