import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { LoginStartLaunch, LoginStartPlatform } from "./opencode-login-start"

export const WINDOWS_LOGIN_TASK = "CodeNomad-OpenCode-Login"
export const WINDOWS_LOGIN_MARKER = "CodeNomad: start OpenCode at login"
const LAUNCHER = "opencode-login-launcher.exe"

/** CommandLineToArgvW quoting, matching the launcher's own re-quoting. */
export function windowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export interface WindowsLoginTask {
  /** The current account's SID: the logon trigger and principal, without password or elevation. */
  user: string
  launcher: string
  launch: LoginStartLaunch
  workingDirectory: string
  /** Isolated native qualification only; production tasks inherit the session environment. */
  environment?: Record<string, string>
  marker?: string
}

export function windowsLoginTaskXml(task: WindowsLoginTask): string {
  if (!/^S-1-\d+(?:-\d+)+$/.test(task.user)) throw new Error("login-start-user")
  const args = [...Object.entries(task.environment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--", task.launch.command, ...task.launch.args].map(windowsArgument).join(" ")
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(task.marker ?? WINDOWS_LOGIN_MARKER)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${task.user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${task.user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(task.launcher)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(task.workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>
`
}

/** PowerShell single-quoted literal; PowerShell also treats typographic quotes as quotes. */
export const psLiteral = (value: string) => `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`

export type PowerShell = (script: string) => Promise<string>
export const runPowerShell: PowerShell = script => {
  const system = process.env.SystemRoot || "C:\\Windows"
  const modules = path.win32.join(system, "System32", "WindowsPowerShell", "v1.0", "Modules")
  const prelude = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Import-Module ${psLiteral(path.win32.join(modules, "ScheduledTasks", "ScheduledTasks.psd1"))};`
  return new Promise((resolve, reject) => execFile(path.win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(prelude + script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8", env: { ...process.env, PSModulePath: modules } },
    (error, stdout) => error ? reject(new Error("login-start-powershell")) : resolve(stdout.trim())))
}

/** Returns one root-folder task, or nothing only when Task Scheduler reports it
 * missing (ObjectNotFound); any other failure stops the script as an error. */
export const findTaskScript = "function Find($n) { try { Get-ScheduledTask -TaskPath '\\' -TaskName $n -ErrorAction Stop } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } } };"

/** Prints absent, owned or foreign for one task in the root folder. */
export const taskStateScript = (name: string, marker: string) =>
  `${findTaskScript}function State { $t=Find ${psLiteral(name)}; if (!$t) { 'absent' } elseif ($t.Description -ceq ${psLiteral(marker)}) { 'owned' } else { 'foreign' } };`

export class WindowsLoginStart implements LoginStartPlatform {
  private readonly name: string
  private readonly marker: string
  private readonly run: PowerShell
  constructor(private readonly options: { name?: string; marker?: string; launcherSource?: string; launcherDirectory?: string
    environment?: Record<string, string>; run?: PowerShell } = {}) {
    this.name = options.name ?? WINDOWS_LOGIN_TASK
    this.marker = options.marker ?? WINDOWS_LOGIN_MARKER
    this.run = options.run ?? runPowerShell
  }

  private state(action = "") {
    return this.run(`${taskStateScript(this.name, this.marker)}${action}State`)
  }

  private launcherDirectory() {
    const local = process.env.LOCALAPPDATA
    if (!this.options.launcherDirectory && (!local || !path.win32.isAbsolute(local))) throw new Error("login-start-localappdata")
    return this.options.launcherDirectory ?? path.win32.join(local!, "CodeNomadOpenCodeLogin")
  }

  async installed() { return await this.state() === "owned" }

  async install(launch: LoginStartLaunch) {
    if (await this.state() === "foreign") throw new Error("login-start-foreign-task")
    const launcher = await this.provisionLauncher()
    const user = await this.run("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value")
    const task = windowsLoginTaskXml({ user, launcher, launch, workingDirectory: os.homedir(), environment: this.options.environment, marker: this.marker })
    const result = await this.state(`if ((State) -eq 'foreign') { 'foreign'; exit 0 }; Register-ScheduledTask -TaskPath '\\' -TaskName ${psLiteral(this.name)} -Xml ${psLiteral(task)} -Force|Out-Null;`)
    if (result !== "owned") throw new Error("login-start-task")
  }

  async remove() {
    const result = await this.state(`if ((State) -eq 'owned') { Unregister-ScheduledTask -TaskPath '\\' -TaskName ${psLiteral(this.name)} -Confirm:$false };`)
    if (result === "owned") throw new Error("login-start-task")
    // The launcher only serves this task. A copy still starting at this instant is retried next time.
    await rm(this.launcherDirectory(), { recursive: true, force: true }).catch(() => {})
  }

  /** A stable copy outside the CodeNomad installation, so updates or a moved
   * installation never leave the task pointing at a replaced file. */
  private async provisionLauncher() {
    const source = this.options.launcherSource ?? fileURLToPath(new URL(`../../dist/host-lifetime/${LAUNCHER}`, import.meta.url))
    const directory = this.launcherDirectory(), target = path.win32.join(directory, LAUNCHER)
    const bytes = await readFile(source)
    if ((await readFile(target).catch(() => undefined))?.equals(bytes)) return target
    await mkdir(directory, { recursive: true })
    const temporary = path.win32.join(directory, `${randomUUID()}.tmp`)
    try { await writeFile(temporary, bytes); await rename(temporary, target) } finally { await rm(temporary, { force: true }) }
    return target
  }
}
