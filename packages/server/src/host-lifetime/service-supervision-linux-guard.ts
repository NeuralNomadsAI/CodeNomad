import { execFile, spawn, type ChildProcess } from "node:child_process"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { ServiceSupervisionStore } from "./service-supervision-store"
import { readLinuxPrivate, writeLinuxPrivate } from "./service-supervision-linux-native"
import { linuxRuntimeSchema } from "./service-supervision-linux"
import { parseSupervisionManifest, type SupervisionHealth } from "./service-supervision-contract"
import { nativeSupervisionStartPermitted, readSupervisionHealth } from "./service-supervision-health"
import { lookupProcess } from "./process-identity"
import { withLinuxSupervisionLock } from "./service-supervision-linux-lock"
import { macosRuntimeSchema } from "./service-supervision-macos"
import { lookupMacosProcess, withMacosSupervisionLock } from "./service-supervision-macos-native"
import { supervisionTargetReady } from "./service-supervision-target"

/** The OS owns this foreground process. SIGTERM/OFF releases its child without
 * signaling it. A live unhealthy child or incumbent is preserved indefinitely. */
async function guard() {
  const [directory, key] = process.argv.slice(2)
  const macos = process.platform === "darwin"
  if ((!macos && process.platform !== "linux") || !directory || !path.isAbsolute(directory)) throw new Error()
  const initial = parseSupervisionManifest(await readLinuxPrivate(path.join(directory, "manifest.json")))
  if (initial.key !== key || initial.namespace.platform !== process.platform || initial.namespace.user !== String(process.getuid!())) throw new Error()
  const runtime = macos ? macosRuntimeSchema.parse(await readLinuxPrivate(path.join(directory, "macos.json")))
    : linuxRuntimeSchema.parse(await readLinuxPrivate(path.join(directory, "linux.json")))
  const nativeHelper = "nativeHelper" in runtime ? runtime.nativeHelper : undefined
  const lookup = macos ? (pid: number) => lookupMacosProcess(pid, nativeHelper) : lookupProcess
  const healthRead = (file: string) => readSupervisionHealth(file, { lookup })
  const lock = <T>(file: string, run: () => Promise<T>) => macos ? withMacosSupervisionLock(file, run, undefined, nativeHelper)
    : withLinuxSupervisionLock(file, run)
  if (path.join(runtime.environment.XDG_CONFIG_HOME, "opencode") !== initial.namespace.configDirectory
    || path.join(runtime.environment.XDG_STATE_HOME, "opencode") !== initial.namespace.stateDirectory) throw new Error()
  const store = new ServiceSupervisionStore(path.dirname(directory), initial.namespace, initial.target, undefined, nativeHelper)
  if (store.directory !== directory) throw new Error()
  const owner = await lookup(process.pid)
  if (owner.state !== "live") throw new Error()
  let running = true, child: ChildProcess | undefined, nextAttempt = 0, failures = 0
  let health: SupervisionHealth = { state: "unknown" }, nextProbe = 0, probeFailures = 0
  let lastAttemptAt: string | undefined, lastStatus = ""
  let firstHealthy: { id: string; at: string; bootSeconds: number } | undefined
  process.on("SIGTERM", () => { running = false })
  process.on("SIGINT", () => { running = false })
  process.on("SIGHUP", () => { running = false })
  const registration = path.join(initial.namespace.stateDirectory, initial.namespace.registrationName)
  try {
    while (running) {
      const manifest = await store.read()
      if (manifest.desired !== "on") break
      if (Date.now() >= nextProbe) {
        health = await healthRead(registration)
        probeFailures = health.state === "healthy" ? 0 : Math.min(probeFailures + 1, 5)
        nextProbe = Date.now() + Math.min(16_000, 1000 * 2 ** Math.max(0, probeFailures - 1))
      }
      const permitted = await nativeSupervisionStartPermitted(path.join(manifest.namespace.configDirectory, manifest.namespace.registrationName))
      let cause: "native-service-disabled-or-unknown" | "start-failed" | "service-unknown" | null = permitted ? null : "native-service-disabled-or-unknown"
      if (child && (child.exitCode !== null || child.signalCode !== null)) child = undefined
      const childLive = child?.pid ? (await lookup(child.pid)).state !== "dead" : false
      if (permitted && health.state === "absent" && !childLive && Date.now() >= nextAttempt) {
        await lock(path.join(directory, "admission.lock"), async () => {
          const current = await store.read()
          if (!running || current.desired !== "on") return
          health = await healthRead(registration)
          if (health.state !== "absent") return
          if (!await nativeSupervisionStartPermitted(path.join(current.namespace.configDirectory, current.namespace.registrationName))) {
            cause = "native-service-disabled-or-unknown"; nextAttempt = Date.now() + 30_000; return
          }
          if (!running || (await store.read()).desired !== "on") return
           lastAttemptAt = new Date().toISOString()
           nextAttempt = Date.now() + Math.min(30_000, 2000 * 2 ** Math.min(failures++, 4))
           const run = (args: string[]) => new Promise<string>((resolve, reject) => execFile(current.target.binary, args,
             { env: { ...runtime.environment, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, timeout: 2000, maxBuffer: 65536 },
             (error, stdout) => error ? reject(new Error("supervision-target-unavailable")) : resolve(stdout.trim())))
           if (!await supervisionTargetReady(current.target, undefined, { namespace: current.namespace, run })) { cause = "start-failed"; return }
           if (!running || (await store.read()).revision !== current.revision) return
          // Independent /dev/null outputs survive guard exit. No detached launcher,
          // kill timer, service stop, profile environment or credential arguments.
          child = spawn(current.target.binary, ["serve", "--service"], { env: { ...runtime.environment, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
            cwd: runtime.environment.HOME, stdio: "ignore" })
          await new Promise<void>(resolve => { child!.once("spawn", resolve); child!.once("error", () => { child = undefined; cause = "start-failed"; resolve() }) })
        }).catch(() => { cause = "service-unknown" })
      }
      if (health.state === "healthy") {
        failures = 0; nextAttempt = 0
        if (!macos && firstHealthy?.id !== health.id) firstHealthy = { id: health.id, at: new Date().toISOString(),
          bootSeconds: Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]) }
      }
      else if (!cause) cause = health.state === "absent" && !childLive ? "start-failed" : "service-unknown"
      const status = { key, revision: manifest.revision, guardPid: process.pid, guardStart: owner.startIdentity, cause,
        mode: childLive ? "hosted" : health.state === "healthy" ? "observed" : "waiting", service: health,
        ...(firstHealthy ? { firstHealthy } : {}),
        ...(lastAttemptAt ? { lastAttemptAt } : {}), ...(nextAttempt > Date.now() ? { retryAt: new Date(nextAttempt).toISOString() } : {}) }
      const bytes = JSON.stringify(status)
      if (bytes !== lastStatus) { await writeLinuxPrivate(path.join(directory, macos ? "macos-status.json" : "linux-status.json"), status); lastStatus = bytes }
      if (running) await new Promise(resolve => setTimeout(resolve, 1000))
    }
  } finally { child?.unref() }
}
guard().catch(() => { process.exitCode = 1 })
