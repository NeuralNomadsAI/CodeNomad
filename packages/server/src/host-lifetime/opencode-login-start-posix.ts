import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readlink, rename, rm, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LoginStartLaunch, LoginStartPlatform } from "./opencode-login-start"

export const MACOS_LOGIN_LABEL = "org.codenomad.opencode-login"
export const LINUX_LOGIN_UNIT = "codenomad-opencode-login.service"
export const LINUX_SYSTEMCTL = "/usr/bin/systemctl"
const DESCRIPTION = "CodeNomad: start OpenCode at login"

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** RunAtLoad starts it at login; launchd relaunches it only after a crash, so an
 * explicit `opencode service stop` keeps it stopped. */
export function macosLoginAgentPlist(launch: LoginStartLaunch): string {
  const args = [launch.command, ...launch.args].map(value => `<string>${xml(value)}</string>`).join("")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MACOS_LOGIN_LABEL}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
</dict>
</plist>
`
}

/** systemd command-line quoting: every word quoted, specifiers and variables escaped. */
export const systemdArgument = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`

export function linuxLoginUnit(launch: LoginStartLaunch): string {
  if (/[\r\n\0]/.test([launch.command, ...launch.args].join(""))) throw new Error("login-start-unit")
  return `[Unit]
Description=${DESCRIPTION}

[Service]
Type=simple
ExecStart=${[launch.command, ...launch.args].map(systemdArgument).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

const owned = (text: string | undefined, marker: string) => text !== undefined && text.includes(marker)
const readText = (file: string) => readFile(file, "utf8").catch(error => {
  if (error.code === "ENOENT") return undefined
  throw error
})
async function replaceFile(file: string, text: string) {
  if (await readText(file) === text) return
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`)
  try { await writeFile(temporary, text, { mode: 0o644 }); await rename(temporary, file) } finally { await rm(temporary, { force: true }) }
}

/** The plist only takes effect at the next login: nothing is loaded, started or
 * booted out now, so a running OpenCode is never touched. */
export class MacosLoginStart implements LoginStartPlatform {
  readonly file: string
  constructor(home = os.homedir()) { this.file = path.join(home, "Library", "LaunchAgents", `${MACOS_LOGIN_LABEL}.plist`) }
  private marker = `<string>${MACOS_LOGIN_LABEL}</string>`
  async installed() { return owned(await readText(this.file), this.marker) }
  async install(launch: LoginStartLaunch) {
    const current = await readText(this.file)
    if (current !== undefined && !owned(current, this.marker)) throw new Error("login-start-foreign-agent")
    await replaceFile(this.file, macosLoginAgentPlist(launch))
  }
  async remove() { if (owned(await readText(this.file), this.marker)) await unlink(this.file) }
}

export type SystemctlCommand = (args: string[]) => Promise<string>
const systemctl: SystemctlCommand = args => new Promise((resolve, reject) => execFile(LINUX_SYSTEMCTL, ["--user", ...args],
  { timeout: 15_000, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout) => error ? reject(new Error("login-start-systemctl")) : resolve(stdout)))

/** Enabled for default.target without linger: the user manager starts it at
 * login and systemd restarts it after a failure. Neither enable nor disable starts
 * or stops the unit, so a running OpenCode keeps running. */
export class LinuxLoginStart implements LoginStartPlatform {
  readonly file: string
  private readonly wanted: string
  constructor(private readonly unitDirectory = path.join(os.homedir(), ".config", "systemd", "user"),
    private readonly command: SystemctlCommand = systemctl) {
    this.file = path.join(unitDirectory, LINUX_LOGIN_UNIT)
    this.wanted = path.join(unitDirectory, "default.target.wants", LINUX_LOGIN_UNIT)
  }
  private marker = `Description=${DESCRIPTION}\n`
  private async linked() {
    try { return path.resolve(path.dirname(this.wanted), await readlink(this.wanted)) === this.file }
    catch { return false }
  }
  async installed() { return owned(await readText(this.file), this.marker) && await this.linked() }
  async install(launch: LoginStartLaunch) {
    const current = await readText(this.file)
    if (current !== undefined && !owned(current, this.marker)) throw new Error("login-start-foreign-unit")
    await replaceFile(this.file, linuxLoginUnit(launch))
    await this.command(["daemon-reload"])
    await this.command(["enable", LINUX_LOGIN_UNIT])
    if (!await this.linked()) throw new Error("login-start-unit")
  }
  async remove() {
    if (!owned(await readText(this.file), this.marker)) return
    // Without a reachable user manager, removing the link and the file still disables it.
    await this.command(["disable", LINUX_LOGIN_UNIT]).catch(() => {})
    if (await this.linked()) await unlink(this.wanted)
    await unlink(this.file)
    await this.command(["daemon-reload"]).catch(() => {})
  }
}
