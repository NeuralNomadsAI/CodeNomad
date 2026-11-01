import { execFile } from "node:child_process"
import { lstat, readFile, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BinaryResolver } from "../settings/binaries"
import type { SettingsService } from "../settings/service"
import type { WorkspaceManager } from "../workspaces/manager"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { buildSpawnSpec, parseWslUncPath } from "../workspaces/spawn"
import { readNativeServiceChannel } from "../workspaces/native-service-registration"
import { runtimeIdentity } from "../opencode/compatibility/runtime"
import { readNativeScheduleIncarnation } from "../opencode/missions/native-schedule-transport-identity"
import { ServiceSupervisionStore } from "./service-supervision-store"
import { ServiceSupervisionSettings, type AcquiredSupervision } from "./service-supervision-service"
import { WindowsServiceSupervision, readWindowsSupervisionRuntime, type WindowsSupervisionRuntime } from "./service-supervision-windows"
import { prepareSupervisionRoot, provisionSupervisionRuntime, supervisionArtifactPolicy } from "./service-supervision-runtime"
import { SupervisionError, supervisionKey } from "./service-supervision-contract"
import { privateStorage, type StoragePolicy } from "./storage"
import { acquirePosixSupervision } from "./service-supervision-linux-resolver"
import { acquireWslSupervision } from "./service-supervision-wsl-resolver"
import { acquireSupervisionTarget, supervisionTargetReady } from "./service-supervision-target"

/** Only the authorized runtime selection is consumed. No project/session list,
 * default registration path, startup profile environment or service lifecycle. */
export function createServiceSupervisionSettings(settings: SettingsService,
  manager: Pick<WorkspaceManager, "resolveBinaryPath">) {
  const resolver = new BinaryResolver(settings)
  const acquire = (connection?: ServiceConnection, selection = false) => (process.platform === "linux" || process.platform === "darwin" ? acquirePosixSupervision : acquireWindowsSupervision)({
    selectedBinary: () => manager.resolveBinaryPath(resolver.resolveDefault().path), connection, selection,
  })
  const supervision = new ServiceSupervisionSettings(acquire, () => acquire(undefined, true))
  // Startup completes previously requested Linux cleanup even if Preferences is
  // never opened. This preserves intent and leaves installation repair explicit.
  if (process.platform === "linux") void supervision.read().catch(() => {})
  return supervision
}

interface Acquisition {
  selectedBinary(): string
  connection?: ServiceConnection
  /** Native qualification supplies isolated roots; never accepted from HTTP. */
  environment?: NodeJS.ProcessEnv
  root?: string
  policy?: StoragePolicy
  artifactPolicy?: StoragePolicy
  selection?: boolean
}

export async function acquireWindowsSupervision(input: Acquisition): Promise<AcquiredSupervision> {
  if (process.platform !== "win32") throw new Error("supervision-platform-unavailable")
  const selected = input.selectedBinary()
  if (parseWslUncPath(selected)) return acquireWslSupervision(input)
  if (!path.isAbsolute(selected)) throw new Error("supervision-host-unavailable")
  // Reuse the lifecycle's published npm-bin/shim resolution. Custom wrappers
  // remain unsupported: the manifest receives only the proven native image.
  const launch = buildSpawnSpec(selected, [], { env: input.environment ?? process.env })
  if (launch.args.length) throw new SupervisionError("invalid")
  const binary = await realpath(launch.command), binaryStat = await lstat(binary)
  // The foreground guard invokes the native image directly, never cmd/PowerShell
  // launchers or an executable found later on PATH.
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || path.extname(binary).toLowerCase() !== ".exe")
    throw new SupervisionError("invalid")
  const selectedTarget = await acquireSupervisionTarget(binary)
  const env = { ...(input.environment ?? process.env) }, system = env.SystemRoot
  if (!system || !path.isAbsolute(system)) throw new SupervisionError("invalid")
  const powershell = path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe")
  const current = () => {
    input.connection?.assertCurrent()
    if (input.selectedBinary() !== selected) throw new SupervisionError("conflict")
  }
  const run = async (file: string, args: string[]) => {
    current()
    const spec = buildSpawnSpec(file, args, { env })
    const text = await new Promise<string>((resolve, reject) => execFile(spec.command, spec.args,
      { env, windowsHide: true, timeout: 5000, maxBuffer: 65536, encoding: "utf8" },
      (error, stdout) => error ? reject(new Error("supervision-namespace-unavailable")) : resolve(stdout.trim())))
    current()
    if (!text || /[\r\n\x00]/.test(text)) throw new Error("supervision-namespace-unavailable")
    return text
  }
  const roots = {} as Record<"config" | "state" | "data" | "cache", string>
  for (const key of ["config", "state", "data", "cache"] as const) {
    const native = await run(binary, ["debug", "paths", key])
    if (!path.isAbsolute(native)) throw new SupervisionError("invalid")
    roots[key] = await realpath(native)
    if (path.basename(roots[key]).toLowerCase() !== "opencode") throw new SupervisionError("invalid")
  }
  const password = await run(binary, ["service", "get", "password"])
  const channel = await readNativeServiceChannel(roots.config, password)
  const user = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"])
  const registration = path.join(roots.state, channel.name)
  const connection = input.connection
  if (connection) {
    current()
    const incarnation = readNativeScheduleIncarnation(registration), identity = runtimeIdentity(connection.endpoint)
    if (!identity || identity.pid !== incarnation.pid || connection.endpoint.url !== incarnation.url
      || connection.endpoint.auth?.type !== "basic" || connection.endpoint.auth.password !== password)
      throw new SupervisionError("conflict")
  }
  const policy = input.policy ?? privateStorage, artifactPolicy = input.artifactPolicy ?? supervisionArtifactPolicy
  if (!env.LOCALAPPDATA) throw new SupervisionError("invalid")
  const root = input.root ?? path.join(env.LOCALAPPDATA, "CodeNomadServiceSupervision")
  const namespace = { platform: "win32" as const, host: os.hostname(), user,
    configDirectory: roots.config, stateDirectory: roots.state, registrationName: channel.name }
  if (input.selection) await lstat(path.join(root, supervisionKey(namespace), "manifest.json")).catch(error => {
    if (error.code === "ENOENT") throw new SupervisionError("unknown-request"); throw error
  })
  current()
  await prepareSupervisionRoot(root, powershell, policy)
  const store = new ServiceSupervisionStore(root, namespace, selectedTarget, policy)
  await store.read()
  let runtime = await readWindowsSupervisionRuntime(store, policy)
  const preparing = !runtime
  if (!runtime) {
    const environment = { SystemRoot: system, WINDIR: system, COMSPEC: path.join(system, "System32/cmd.exe") } as WindowsSupervisionRuntime["environment"]
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] as const) {
      const value = env[key] ?? (key === "HOME" ? env.USERPROFILE : undefined)
      if (!value || !path.isAbsolute(value)) throw new SupervisionError("invalid")
      environment[key] = await realpath(value)
    }
    for (const key of ["config", "state", "data", "cache"] as const)
      environment[`XDG_${key.toUpperCase()}_HOME` as "XDG_CONFIG_HOME"] = path.dirname(roots[key])
    // The native test-home override is a path, only from the acquired process.
    if (env.OPENCODE_TEST_HOME) environment.OPENCODE_TEST_HOME = await realpath(env.OPENCODE_TEST_HOME)
    current()
    runtime = { powershell, ...await provisionSupervisionRuntime(store.directory, artifactPolicy), environment }
  }
  current()
  const adapter = new WindowsServiceSupervision(store, runtime, policy, artifactPolicy)
  if (preparing) { current(); await adapter.prepareRuntime(); current() }
  if (!await supervisionTargetReady(selectedTarget)) throw new SupervisionError("conflict")
  current()
  return { store, adapter, selectedTarget, assertCurrent: current }
}
