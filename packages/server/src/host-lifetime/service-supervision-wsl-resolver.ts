import { execFile } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { parseWslUncPath } from "../workspaces/spawn"
import { readNativeServiceChannel } from "../workspaces/native-service-registration"
import { runtimeIdentity } from "../opencode/compatibility/runtime"
import { readNativeScheduleIncarnation } from "../opencode/missions/native-schedule-transport-identity"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { AcquiredSupervision } from "./service-supervision-service"
import { SupervisionError, supervisionKey } from "./service-supervision-contract"
import { ServiceSupervisionStore } from "./service-supervision-store"
import { WindowsServiceSupervision, readWindowsSupervisionRuntime, type WindowsSupervisionRuntime } from "./service-supervision-windows"
import { prepareSupervisionRoot, provisionSupervisionRuntime, supervisionArtifactPolicy } from "./service-supervision-runtime"
import { privateStorage, type StoragePolicy } from "./storage"
import { runSupervisionWsl, wslRuntimeSchema, type WslSupervisionRuntime } from "./service-supervision-wsl"
import { mutateWslSupervisionFile } from "./service-supervision-wsl-lock"
import { acquireSupervisionTarget, supervisionTargetReady } from "./service-supervision-target"

export async function acquireWslSupervision(input: {
  selectedBinary(): string; connection?: ServiceConnection; environment?: NodeJS.ProcessEnv
  root?: string; policy?: StoragePolicy; artifactPolicy?: StoragePolicy
  selection?: boolean
  /** Qualification-only native paths; never accepted by the Settings HTTP route. */
  nativeEnvironment?: WslSupervisionRuntime["environment"]
}): Promise<AcquiredSupervision> {
  if (process.platform !== "win32") throw new Error("supervision-platform-unavailable")
  const selected = input.selectedBinary(), parsed = parseWslUncPath(selected)
  if (!parsed) throw new SupervisionError("invalid")
  const env = input.environment ?? process.env, system = env.SystemRoot
  if (!system || !path.win32.isAbsolute(system) || !env.LOCALAPPDATA) throw new SupervisionError("invalid")
  const powershell = path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe")
  const executable = path.join(system, "System32/wsl.exe")
  const current = () => {
    input.connection?.assertCurrent()
    if (input.selectedBinary() !== selected) throw new SupervisionError("conflict")
  }
  const ps = (script: string) => new Promise<string>((resolve, reject) => execFile(powershell,
    ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000, maxBuffer: 65536 },
    (error, stdout) => error ? reject(new Error("supervision-wsl-identity")) : resolve(stdout.trim())))
  // Windows' registered distro spelling is stable across UNC aliases and case.
  const names: unknown = JSON.parse(await ps("ConvertTo-Json -InputObject @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' | ForEach-Object { (Get-ItemProperty $_.PSPath).DistributionName }) -Compress"))
  if (!Array.isArray(names)) throw new SupervisionError("invalid")
  const matches = names.filter((name): name is string => typeof name === "string" && name.toLowerCase() === parsed.distro.toLowerCase())
  if (matches.length !== 1) throw new SupervisionError("invalid")
  const distro = matches[0]!, owner = await ps("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value")
  const initial = { executable, distro }
  const user = await runSupervisionWsl(initial, ["/usr/bin/id", "-u"])
  const account = await runSupervisionWsl(initial, ["/usr/bin/id", "-un"])
  const home = await runSupervisionWsl({ ...initial, account }, ["/bin/sh", "-c", 'printf "%s" "$HOME"'])
  const binary = await runSupervisionWsl({ ...initial, account }, ["/usr/bin/readlink", "-e", "--", parsed.linuxPath])
  const map = (native: string) => runSupervisionWsl({ ...initial, account }, ["/usr/bin/wslpath", "-w", native])
  const selectedTarget = await acquireSupervisionTarget(binary, map, false)
  const nativeEnv = input.nativeEnvironment ?? { HOME: home }
  const run = async (args: string[]) => {
    current()
    const text = await runSupervisionWsl({ ...initial, account }, ["/usr/bin/env", "-i",
      ...Object.entries(nativeEnv).map(([key, value]) => `${key}=${value}`), "PATH=/usr/bin:/bin", binary, ...args])
    current()
    if (!text || /[\r\n\x00]/.test(text)) throw new SupervisionError("invalid")
    return text
  }
  const environment = { HOME: home } as WslSupervisionRuntime["environment"]
  const roots = {} as Record<"config" | "state" | "data" | "cache", string>
  for (const name of ["config", "state", "data", "cache"] as const) {
    const native = await run(["debug", "paths", name])
    roots[name] = await runSupervisionWsl({ ...initial, account }, ["/usr/bin/readlink", "-e", "--", native])
    if (path.posix.basename(roots[name]) !== "opencode") throw new SupervisionError("invalid")
    environment[`XDG_${name.toUpperCase()}_HOME` as "XDG_CONFIG_HOME"] = path.posix.dirname(roots[name])
  }
  if (input.nativeEnvironment) Object.assign(environment, input.nativeEnvironment)
  const password = await run(["service", "get", "password"])
  const channel = await readNativeServiceChannel(await map(roots.config), password)
  const connection = input.connection
  if (connection) {
    current()
    const incarnation = readNativeScheduleIncarnation(await map(path.posix.join(roots.state, channel.name)))
    const identity = runtimeIdentity(connection.endpoint)
    if (!identity || identity.pid !== incarnation.pid || connection.endpoint.url !== incarnation.url
      || connection.endpoint.auth?.type !== "basic" || connection.endpoint.auth.password !== password) throw new SupervisionError("conflict")
  }
  const policy = input.policy ?? privateStorage, artifactPolicy = input.artifactPolicy ?? supervisionArtifactPolicy
  const root = input.root ?? path.join(env.LOCALAPPDATA, "CodeNomadServiceSupervision")
  const namespace = { platform: "wsl" as const, host: `${os.hostname()}:${owner}`, user, distro,
    configDirectory: roots.config, stateDirectory: roots.state, registrationName: channel.name }
  if (input.selection) await lstat(path.join(root, supervisionKey(namespace), "manifest.json")).catch(error => {
    if (error.code === "ENOENT") throw new SupervisionError("unknown-request"); throw error
  })
  current()
  await prepareSupervisionRoot(root, powershell, policy)
  // WSL distro registrations belong to a Windows SID. Two Windows accounts can
  // have identically named distros/UIDs/roots but must never share task names.
  let store = new ServiceSupervisionStore(root, namespace, selectedTarget, policy)
  const manifestPath = await runSupervisionWsl({ ...initial, account }, ["/usr/bin/wslpath", "-u", path.join(store.directory, "manifest.json")])
  const wsl = wslRuntimeSchema.parse({ ...initial, user, account, owner, environment, manifest: manifestPath })
  const initialManifest = await store.read()
  store = new ServiceSupervisionStore(root, initialManifest.namespace, initialManifest.target, policy, undefined,
    update => mutateWslSupervisionFile(wsl, update))
  let runtime = await readWindowsSupervisionRuntime(store, policy)
  if (!runtime) {
    const windowsEnvironment = { SystemRoot: system, WINDIR: system, COMSPEC: path.join(system, "System32/cmd.exe") } as WindowsSupervisionRuntime["environment"]
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] as const) {
      const value = env[key] ?? (key === "HOME" ? env.USERPROFILE : undefined)
      if (!value || !path.win32.isAbsolute(value)) throw new SupervisionError("invalid")
      windowsEnvironment[key] = await realpath(value)
    }
    for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const) windowsEnvironment[key] = root
    runtime = { powershell, ...await provisionSupervisionRuntime(store.directory, artifactPolicy), environment: windowsEnvironment, wsl }
  } else if (JSON.stringify(runtime.wsl) !== JSON.stringify(wsl)) throw new SupervisionError("conflict")
  for (const file of [binary, roots.config, roots.state]) {
    // Explicit native canonicalization above; do not resolve Linux PIDs or paths
    // through Windows' process namespace or the selected profile's environment.
    if (!file.startsWith("/")) throw new SupervisionError("invalid")
  }
  if (!(await lstat(await map(binary))).isFile()) throw new SupervisionError("invalid")
  current()
  const adapter = new WindowsServiceSupervision(store, runtime, policy, artifactPolicy)
  await adapter.prepareRuntime()
  if (!await supervisionTargetReady(selectedTarget, map)) throw new SupervisionError("conflict")
  current()
  return { store, adapter, selectedTarget, assertCurrent: current }
}
