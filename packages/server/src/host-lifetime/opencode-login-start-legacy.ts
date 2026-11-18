import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, readdir, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { findTaskScript, psLiteral, runPowerShell, type PowerShell } from "./opencode-login-start-windows"

/** The former "Keep OpenCode running" supervision: one directory per service key
 * under a private root, with Windows Main/Recovery tasks, a macOS LaunchAgent or
 * a systemd user unit hosting a guard, and Linux linger recorded as owned only
 * when CodeNomad enabled it. Retiring releases each guard first (OpenCode keeps
 * running as the guard's released child), then removes exactly those resources. */
export interface LegacySupervision {
  scan(): Promise<{ present: boolean; on: boolean }>
  retire(): Promise<void>
}

type Command = (file: string, args: string[]) => Promise<string>
const command: Command = (file, args) => new Promise((resolve, reject) => execFile(file, args,
  { timeout: 15_000, maxBuffer: 64 * 1024, encoding: "utf8", windowsHide: true },
  (error, stdout) => error ? reject(new Error("login-start-legacy-command")) : resolve(stdout.trim())))

interface Entry { key: string; directory: string; manifest?: Record<string, unknown> }
const MANIFEST_BYTES = 64 * 1024

async function entries(root: string): Promise<Entry[]> {
  const names = await readdir(root).catch(error => { if (error.code === "ENOENT") return [] as string[]; throw error })
  const found: Entry[] = []
  for (const key of names.filter(name => /^[a-f0-9]{64}$/.test(name))) {
    const directory = path.join(root, key)
    if (!(await lstat(directory)).isDirectory()) continue
    let manifest: Record<string, unknown> | undefined
    try {
      const file = path.join(directory, "manifest.json")
      if ((await lstat(file)).size <= MANIFEST_BYTES) {
        const value = JSON.parse(await readFile(file, "utf8"))
        if (value && typeof value === "object" && value.key === key) manifest = value
      }
    } catch { /* An unreadable manifest only stops its guard; its resources are still retired. */ }
    found.push({ key, directory, manifest })
  }
  return found
}

/** The guard rereads its manifest and releases its child once the preference is off. */
async function release(entry: Entry) {
  const manifest = entry.manifest
  if (!manifest || manifest.desired === "off") return
  const revision = typeof manifest.revision === "number" ? manifest.revision + 1 : 1
  const file = path.join(entry.directory, "manifest.json"), temporary = path.join(entry.directory, `${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify({ ...manifest, desired: "off", revision, receipt: null }), { mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break } catch (error) {
        // A guard reading the manifest can hold it open for an instant on Windows.
        if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  } finally { await rm(temporary, { force: true }) }
  entry.manifest = { ...manifest, desired: "off", revision }
}

async function removeRootWhenEmpty(root: string) {
  await rmdir(root).catch(() => {})
}

export interface LegacyOptions {
  platform?: NodeJS.Platform
  root?: string
  home?: string
  powershell?: PowerShell
  command?: Command
  uid?: string
  username?: string
  lingerFingerprint?: () => Promise<string | null>
}

export function legacySupervision(options: LegacyOptions = {}): LegacySupervision | undefined {
  const platform = options.platform ?? process.platform
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA
    const root = options.root ?? (local && path.win32.isAbsolute(local) ? path.win32.join(local, "CodeNomadServiceSupervision") : undefined)
    return root ? new WindowsLegacy(root, options.powershell ?? runPowerShell) : undefined
  }
  if (platform !== "linux" && platform !== "darwin") return undefined
  const home = options.home ?? os.homedir()
  const root = options.root ?? path.join(home, ".codenomad-service-supervision")
  const uid = options.uid ?? String(process.getuid?.() ?? "")
  if (!/^\d+$/.test(uid)) return undefined
  const run = options.command ?? command
  return platform === "darwin" ? new MacosLegacy(root, home, uid, run)
    : new LinuxLegacy(root, home, uid, options.username ?? os.userInfo().username, run, options.lingerFingerprint)
}

abstract class LegacyRoot implements LegacySupervision {
  constructor(protected readonly root: string) {}
  protected abstract retireEntry(entry: Entry): Promise<boolean>
  protected async extra(): Promise<{ present: boolean; retire(): Promise<boolean> }> {
    return { present: false, retire: async () => true }
  }
  async scan() {
    const found = await entries(this.root), extra = await this.extra()
    return { present: found.length > 0 || extra.present, on: found.some(entry => entry.manifest?.desired === "on") }
  }
  async retire() {
    let complete = true
    for (const entry of await entries(this.root)) {
      await release(entry)
      if (await this.retireEntry(entry)) await rm(entry.directory, { recursive: true, force: true }).catch(() => { complete = false })
      else complete = false
    }
    if (!await (await this.extra()).retire()) complete = false
    if (complete) await removeRootWhenEmpty(this.root)
  }
}

export const legacyTaskNames = (key: string) => ({ main: `CodeNomad-OpenCode-${key}-Main`, recovery: `CodeNomad-OpenCode-${key}-Recovery`,
  marker: `CodeNomad OpenCode supervision v1 key=${key} root=` })

class WindowsLegacy extends LegacyRoot {
  constructor(root: string, private readonly run: PowerShell) { super(root) }
  /** Disable both tasks, wait for Main's released guard to exit, then unregister
   * them. A running Main is never stopped: its job still holds OpenCode. */
  protected async retireEntry(entry: Entry) {
    const { main, recovery, marker } = legacyTaskNames(entry.key)
    // The former marker names the exact directory; PowerShell's -eq ignores case like Windows paths.
    const owned = `${findTaskScript}function Owned($n) { $t=Find $n; if ($t -and [string]$t.Description -eq ${psLiteral(marker + entry.directory)}) { $t } };`
    const result = await this.run(`${owned}$main=${psLiteral(main)};$recovery=${psLiteral(recovery)};
foreach ($n in @($recovery,$main)) { $t=Owned $n; if ($t) { Disable-ScheduledTask -InputObject $t|Out-Null } }
$deadline=[datetime]::UtcNow.AddSeconds(15)
do { $a=Owned $main; if (!$a -or $a.State -notin @('Running','Queued')) { break }; Start-Sleep -Milliseconds 200 } while ([datetime]::UtcNow -lt $deadline)
$b=Owned $recovery; if ($b) { Stop-ScheduledTask -InputObject $b; Unregister-ScheduledTask -InputObject $b -Confirm:$false }
$a=Owned $main; if ($a -and $a.State -in @('Running','Queued')) { 'pending'; exit 0 }
if ($a) { Unregister-ScheduledTask -InputObject $a -Confirm:$false }
# A same-key task naming another root keeps the directory, so it stays visible to the next pass.
foreach ($n in @($main,$recovery)) { $t=Find $n; if ($t -and ([string]$t.Description).StartsWith(${psLiteral(marker)}, [StringComparison]::OrdinalIgnoreCase)) { 'pending'; exit 0 } }
'removed'`)
    return result === "removed"
  }
}

class MacosLegacy extends LegacyRoot {
  constructor(root: string, private readonly home: string, private readonly uid: string, private readonly run: Command) { super(root) }
  /** bootout ends only the guard (AbandonProcessGroup keeps its released OpenCode). */
  protected async retireEntry(entry: Entry) {
    const label = `org.codenomad.opencode.${entry.key}`, target = `gui/${this.uid}/${label}`
    const plist = path.join(this.home, "Library", "LaunchAgents", `${label}.plist`)
    const text = await readFile(plist, "utf8").catch(() => undefined)
    if (text === undefined || !text.includes(`<string>${label}</string>`)) return true
    await this.run("/bin/launchctl", ["bootout", target]).catch(() => {})
    if (await this.run("/bin/launchctl", ["print", target]).then(() => true, () => false)) return false
    await unlink(plist)
    return true
  }
}

const lingerSchema = (value: unknown) => value && typeof value === "object" ? value as { phase?: unknown; fingerprint?: unknown; user?: unknown } : undefined

class LinuxLegacy extends LegacyRoot {
  constructor(root: string, private readonly home: string, private readonly uid: string, username: string,
    private readonly run: Command, private readonly fingerprint = async () => {
      try {
        const s = await lstat(`/var/lib/systemd/linger/${username}`, { bigint: true })
        return s.isFile() && !s.isSymbolicLink() && s.uid === 0n ? `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}` : null
      } catch { return null }
    }) { super(root) }

  /** Stop only while the loaded unit is exactly this file with KillMode=process and
   * no drop-in: only the guard ends and OpenCode survives in its released cgroup.
   * Disable and unlink follow, never before. */
  protected async retireEntry(entry: Entry) {
    const unit = `codenomad-opencode-${entry.key}.service`, file = path.join(this.home, ".config", "systemd", "user", unit)
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text === undefined || !text.includes(`Description=CodeNomad OpenCode ${entry.key}\n`) || !text.includes("KillMode=process\n")) return true
    try {
      const loaded = Object.fromEntries((await this.run("/usr/bin/systemctl", ["--user", "show", unit,
        "--property=LoadState,FragmentPath,KillMode,DropInPaths"])).split("\n").map(line => {
        const index = line.indexOf("=")
        return [line.slice(0, index), line.slice(index + 1)]
      }))
      if (loaded.LoadState !== "not-found") {
        const same = loaded.FragmentPath === file || await Promise.all([realpath(file), realpath(loaded.FragmentPath ?? "")])
          .then(([a, b]) => a === b, () => false)
        if (!same || loaded.KillMode !== "process" || loaded.DropInPaths) return false
        await this.run("/usr/bin/systemctl", ["--user", "stop", unit])
      }
      await this.run("/usr/bin/systemctl", ["--user", "disable", unit])
    } catch { return false }
    await unlink(file)
    await this.run("/usr/bin/systemctl", ["--user", "daemon-reload"]).catch(() => {})
    return true
  }

  protected async extra() {
    const file = path.join(this.root, "linux-linger.json")
    const raw = await readFile(file, "utf8").catch(() => undefined)
    return { present: raw !== undefined, retire: async () => {
      if (raw === undefined) return true
      let registry: ReturnType<typeof lingerSchema>
      try { registry = lingerSchema(JSON.parse(raw)) } catch { registry = undefined }
      // Only linger CodeNomad enabled itself, with its marker unchanged, is restored.
      // Personal, external, uncertain or altered linger stays exactly as it is.
      if (registry?.phase === "owned" && registry.user === this.uid && typeof registry.fingerprint === "string"
        && registry.fingerprint === await this.fingerprint()
        && await this.run("/usr/bin/loginctl", ["show-user", this.uid, "--property=Linger", "--value"]).then(value => value === "yes", () => false)) {
        // Disabling linger without an open session ends the user manager and its OpenCode.
        if (!await this.sessionOpen()) return false
        try { await this.run("/usr/bin/loginctl", ["--no-ask-password", "disable-linger", this.uid]) } catch { return false }
      }
      await unlink(file).catch(() => {})
      await rm(path.join(this.root, "linux-linger.lock"), { force: true })
      return true
    } }
  }

  private async sessionOpen() {
    const sessions = await this.run("/usr/bin/loginctl", ["show-user", this.uid, "--property=Sessions", "--value"]).catch(() => "")
    for (const id of sessions.split(/\s+/).filter(value => /^[A-Za-z0-9_-]+$/.test(value))) {
      const state = await this.run("/usr/bin/loginctl", ["show-session", id, "--property=State", "--value"]).catch(() => "")
      if (state === "active" || state === "online") return true
    }
    return false
  }
}
