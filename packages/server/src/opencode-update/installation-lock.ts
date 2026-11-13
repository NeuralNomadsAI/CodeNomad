import { mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises"
import path from "node:path"

const INSTALLER_DIRECTORY = /^\.codenomad-(?:npm|upgrade)-/

/** Private installer commands live beside the lock in the npm prefix, which must
 * allow execution for the installed commands anyway; a temporary directory may be
 * mounted noexec. Neither npm nor OpenCode resolves dot directories in the prefix. */
export async function createInstallerDirectory(prefix: string, kind: "npm" | "upgrade"): Promise<string> {
  await mkdir(prefix, { recursive: true })
  return mkdtemp(path.join(prefix, `.codenomad-${kind}-`))
}

export class InstallationBusyError extends Error {
  constructor(readonly code: "installation_busy" | "installation_in_use", message: string) {
    super(message)
  }
}

/** Forced termination of the supervisor does not establish npm child exit. */
export class InstallationInterruptedError extends InstallationBusyError {
  constructor() {
    super("installation_busy", "OpenCode installer was interrupted; verify its child processes have exited before removing the installation lock")
  }
}

/** Serializes CodeNomad backends sharing a standard npm prefix. Never steal a
 * lock on a timeout: an orphaned npm child can outlive its backend. After a crash,
 * remove the lock only after checking that the installer has exited. */
export async function withInstallationLock<T>(prefix: string, install: () => Promise<T>): Promise<T> {
  await mkdir(prefix, { recursive: true })
  const lock = path.join(prefix, ".codenomad-opencode-install.lock")
  const handle = await open(lock, "wx", 0o600).catch(error => {
    if (error.code === "EEXIST") throw new InstallationBusyError("installation_busy", `OpenCode installation lock exists: ${lock}`)
    throw error
  })
  let retain = false
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }))
    // A fresh lock means any retained installer directory belongs to an
    // interrupted installer whose exit was verified before its lock was removed.
    for (const entry of await readdir(prefix, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && INSTALLER_DIRECTORY.test(entry.name)) {
        await rm(path.join(prefix, entry.name), { recursive: true, force: true }).catch(() => {})
      }
    }
    return await install()
  } catch (error) {
    retain = error instanceof InstallationInterruptedError
    if (retain) (error as Error).message += `: ${lock}`
    throw error
  } finally {
    await handle.close()
    if (!retain) await rm(lock)
  }
}

/** Windows forbids writing a mapped executable. Check before npm can retire the
 * old package; do not stop the daemon or leave a partially replaced installation. */
export async function assertExecutableWritable(binary: string, platform = process.platform) {
  if (platform !== "win32") return
  try { await (await open(binary, "r+")).close() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw new InstallationBusyError("installation_in_use", "The OpenCode executable is in use or not writable")
  }
}
