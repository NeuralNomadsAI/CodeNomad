import { execFile } from "node:child_process"
import { lstat, mkdir, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runtimeIdentity } from "../opencode/compatibility/runtime"
import { readNativeScheduleIncarnation } from "../opencode/missions/native-schedule-transport-identity"
import { readNativeServiceChannel } from "../workspaces/native-service-registration"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { SupervisionError, supervisionKey } from "./service-supervision-contract"
import { ServiceSupervisionStore } from "./service-supervision-store"
import { LinuxServiceSupervision, readLinuxSupervisionRuntime, type LinuxSupervisionRuntime } from "./service-supervision-linux"
import { LinuxSupervisionLinger } from "./service-supervision-linux-linger"
import { provisionLinuxSupervisionRuntime } from "./service-supervision-linux-runtime"
import type { AcquiredSupervision } from "./service-supervision-service"
import { privateStorage } from "./storage"
import { MacosServiceSupervision, readMacosSupervisionRuntime, type MacosSupervisionRuntime } from "./service-supervision-macos"
import { macosNativeHelper } from "./service-supervision-macos-native"
import { acquireSupervisionTarget, supervisionTargetReady } from "./service-supervision-target"

interface Acquisition { selectedBinary(): string; connection?: ServiceConnection;
  environment?: NodeJS.ProcessEnv; root?: string; guardSource?: string; nativeHelperSource?: string; selection?: boolean }
export async function acquireLinuxSupervision(input: Acquisition): Promise<AcquiredSupervision> {
  if (process.platform !== "linux") throw new Error("supervision-platform-unavailable")
  return acquirePosixSupervision(input)
}
export async function acquirePosixSupervision(input: Acquisition): Promise<AcquiredSupervision> {
  const macos = process.platform === "darwin"
  if ((!macos && process.platform !== "linux") || process.env.WSL_DISTRO_NAME || /microsoft/i.test(os.release())) throw new Error("supervision-platform-unavailable")
  const selected = input.selectedBinary(), env = { ...(input.environment ?? process.env) }
  if (!path.isAbsolute(selected)) throw new SupervisionError("invalid")
  const binary = await realpath(selected), stat = await lstat(binary)
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) throw new SupervisionError("invalid")
  const selectedTarget = await acquireSupervisionTarget(binary)
  const current = () => { input.connection?.assertCurrent(); if (selected !== input.selectedBinary()) throw new SupervisionError("conflict") }
  const run = async (args: string[]) => {
    current()
    const result = await new Promise<string>((resolve, reject) => execFile(binary, args,
      { env, timeout: 5000, maxBuffer: 65536 }, (error, stdout) => error ? reject(new SupervisionError("invalid")) : resolve(stdout.trim())))
    current()
    if (!result || /[\r\n\x00]/.test(result)) throw new SupervisionError("invalid")
    return result
  }
  const roots = {} as Record<"config" | "state" | "data" | "cache", string>
  for (const key of ["config", "state", "data", "cache"] as const) {
    const value = await run(["debug", "paths", key])
    if (!path.isAbsolute(value)) throw new SupervisionError("invalid")
    roots[key] = await realpath(value)
    if (path.basename(roots[key]) !== "opencode") throw new SupervisionError("invalid")
  }
  const password = await run(["service", "get", "password"]), channel = await readNativeServiceChannel(roots.config, password)
  if (input.connection) {
    const identity = runtimeIdentity(input.connection.endpoint), incarnation = readNativeScheduleIncarnation(path.join(roots.state, channel.name))
    if (!identity || identity.pid !== incarnation.pid || input.connection.endpoint.url !== incarnation.url
      || input.connection.endpoint.auth?.type !== "basic" || input.connection.endpoint.auth.password !== password) throw new SupervisionError("conflict")
  }
  // The linger ownership registry lives outside XDG/profile/channel namespaces.
  const home = await realpath(os.userInfo().homedir), root = input.root ?? path.join(home, ".codenomad-service-supervision")
  const namespace = { platform: process.platform as "linux" | "darwin", host: os.hostname(), user: String(process.getuid!()),
    configDirectory: roots.config, stateDirectory: roots.state, registrationName: channel.name }
  if (input.selection) await lstat(path.join(root, supervisionKey(namespace), "manifest.json")).catch(error => {
    if (error.code === "ENOENT") throw new SupervisionError("unknown-request"); throw error
  })
  await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error })
  await privateStorage.verify(root, true)
  let store = new ServiceSupervisionStore(root, namespace, selectedTarget)
  const manifest = await store.read()
  let runtime: LinuxSupervisionRuntime | MacosSupervisionRuntime | undefined = macos ? await readMacosSupervisionRuntime(store) : await readLinuxSupervisionRuntime(store)
  if (!runtime) {
    const environment = { HOME: await realpath(env.HOME ?? home) } as LinuxSupervisionRuntime["environment"]
    for (const key of ["config", "state", "data", "cache"] as const) environment[`XDG_${key.toUpperCase()}_HOME` as "XDG_CONFIG_HOME"] = path.dirname(roots[key])
    if (env.OPENCODE_TEST_HOME) environment.OPENCODE_TEST_HOME = await realpath(env.OPENCODE_TEST_HOME)
    const artifacts = await provisionLinuxSupervisionRuntime(store.directory, privateStorage, { node: process.execPath,
      guard: input.guardSource ?? fileURLToPath(new URL("../../dist/host-lifetime/service-supervision-linux-guard.cjs", import.meta.url)),
      ...(macos ? { nativeHelper: input.nativeHelperSource ?? macosNativeHelper() } : {}) })
    runtime = macos ? { ...artifacts, nativeHelper: artifacts.nativeHelper!, agentDirectory: path.join(home, "Library/LaunchAgents"), environment }
      : { ...artifacts, unitDirectory: path.join(home, ".config/systemd/user"), environment }
  }
  current()
  if ("nativeHelper" in runtime) {
    store = new ServiceSupervisionStore(root, manifest.namespace, manifest.target, privateStorage, runtime.nativeHelper)
    const adapter = new MacosServiceSupervision(store, runtime)
    await adapter.prepareRuntime(); current()
    if (!await supervisionTargetReady(selectedTarget)) throw new SupervisionError("conflict")
    current()
    return { store, adapter, selectedTarget, assertCurrent: current }
  }
  const linger = new LinuxSupervisionLinger(root, String(process.getuid!()), os.hostname(), os.userInfo().username)
  await linger.reconcileDeferred()
  const adapter = new LinuxServiceSupervision(store, runtime, linger)
  await adapter.prepareRuntime(); current()
  if (!await supervisionTargetReady(selectedTarget)) throw new SupervisionError("conflict")
  current()
  return { store, adapter, selectedTarget, assertCurrent: current }
}
