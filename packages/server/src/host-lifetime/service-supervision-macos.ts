import { execFile } from "node:child_process"
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { setTimeout as delay } from "node:timers/promises"
import { SupervisionError, type SupervisionObservation } from "./service-supervision-contract"
import { ServiceSupervisionStore } from "./service-supervision-store"
import { linuxRuntimeSchema } from "./service-supervision-linux"
import { preparePosixSupervisionDirectory, readLinuxPrivate as readPrivate, writeLinuxPrivate as writePrivate } from "./service-supervision-linux-native"
import { lookupMacosProcess, withMacosSupervisionLock } from "./service-supervision-macos-native"
import { readSupervisionHealth } from "./service-supervision-health"
import { privateStorage, type StoragePolicy } from "./storage"

const absolute = z.string().min(1).max(4096).refine(value => path.posix.isAbsolute(value)
  && path.posix.normalize(value) === value && !/[\x00-\x1f\\]/.test(value))
export const macosRuntimeSchema = linuxRuntimeSchema.omit({ unitDirectory: true }).extend({ nativeHelper: absolute, agentDirectory: absolute })
export type MacosSupervisionRuntime = z.infer<typeof macosRuntimeSchema>
export type MacosLaunchctl = (args: string[]) => Promise<{ code: number; text: string }>
const launchctl: MacosLaunchctl = args => new Promise((resolve, reject) => execFile("/bin/launchctl", args,
  { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME }, timeout: 20_000, maxBuffer: 65536 }, (error, stdout) => {
    if (error && typeof error.code !== "number") return reject(new SupervisionError("busy"))
    resolve({ code: error ? Number(error.code) : 0, text: stdout.trim() })
  }))
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")

export function macosSupervisionPlist(key: string, directory: string, raw: MacosSupervisionRuntime): string {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new SupervisionError("invalid")
  const d = macosRuntimeSchema.parse(raw)
  absolute.parse(directory)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>org.codenomad.opencode.${key}</string>
<key>ProgramArguments</key><array>${[d.node, d.guard, directory, key].map(value => `<string>${xml(value)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>AbandonProcessGroup</key><true/>
<key>StandardInPath</key><string>/dev/null</string>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`
}

/** launchctl's bounded print output is independent evidence of the loaded action.
 * Verify its path, complete argv and release/restart policy before any mutation. */
export function macosLoadedAgent(text: string, file: string, argv: string[]): { pid?: number; state: string } {
  const scalar = (name: string) => text.match(new RegExp(`^\\t${name} = (.+)$`, "m"))?.[1]
  const args = text.match(/^\targuments = \{\n([\s\S]*?)^\t\}/m)?.[1].split("\n").filter(Boolean).map(line => line.replace(/^\t\t/, ""))
  const properties = scalar("properties")?.split(/\s*\|\s*/)
  if (scalar("type") !== "LaunchAgent" || scalar("minimum runtime") !== "5" || scalar("path") !== file || scalar("program") !== argv[0] || JSON.stringify(args) !== JSON.stringify(argv)
    || !["keepalive", "runatload", "abandon process group"].every(value => properties?.includes(value))) throw new SupervisionError("conflict")
  const pid = scalar("pid")
  if (pid !== undefined && !/^[1-9]\d*$/.test(pid)) throw new SupervisionError("invalid")
  return { state: scalar("state") ?? "unknown", ...(pid ? { pid: Number(pid) } : {}) }
}

export async function readMacosSupervisionRuntime(store: ServiceSupervisionStore, policy: StoragePolicy = privateStorage) {
  const raw = await readPrivate(path.join(store.directory, "macos.json"), policy)
  return raw === undefined ? undefined : macosRuntimeSchema.parse(raw)
}

export class MacosServiceSupervision {
  constructor(private readonly store: ServiceSupervisionStore, private readonly runtime: MacosSupervisionRuntime,
    private readonly policy: StoragePolicy = privateStorage, private readonly command: MacosLaunchctl = launchctl) {}

  async prepareRuntime() {
    const d = macosRuntimeSchema.parse(this.runtime), m = await this.store.read()
    if (m.namespace.platform !== "darwin" || path.posix.join(d.environment.XDG_CONFIG_HOME, "opencode") !== m.namespace.configDirectory
      || path.posix.join(d.environment.XDG_STATE_HOME, "opencode") !== m.namespace.stateDirectory) throw new SupervisionError("conflict")
    const existing = await readMacosSupervisionRuntime(this.store, this.policy)
    if (existing && JSON.stringify(existing) !== JSON.stringify(d)) throw new SupervisionError("conflict")
    if (!existing) await writePrivate(path.join(this.store.directory, "macos.json"), d, this.policy)
  }
  private async agent() {
    const m = await this.store.read(), label = `org.codenomad.opencode.${m.key}`, file = path.join(this.runtime.agentDirectory, `${label}.plist`)
    return { label, file, target: `gui/${m.namespace.user}/${label}`, text: macosSupervisionPlist(m.key, this.store.directory, this.runtime),
      argv: [this.runtime.node, this.runtime.guard, this.store.directory, m.key] }
  }
  private async ownedAgent() {
    const agent = await this.agent()
    const stat = await lstat(agent.file).catch(error => { if (error.code !== "ENOENT") throw error; return null })
    if (!stat) return { ...agent, exists: false }
    await this.policy.verify(agent.file, false)
    if (stat.size > 32768 || await readFile(agent.file, "utf8") !== agent.text) throw new SupervisionError("conflict")
    return { ...agent, exists: true }
  }
  private async loaded(agent: Awaited<ReturnType<MacosServiceSupervision["agent"]>>) {
    const result = await this.command(["print", agent.target])
    if (result.code === 113) return null // Exact missing service, not a missing GUI domain or permission error.
    if (result.code !== 0) throw new SupervisionError("busy")
    return macosLoadedAgent(result.text, agent.file, agent.argv)
  }
  async reconcile(expectedRevision: number) {
    await this.prepareRuntime()
    await withMacosSupervisionLock(path.join(this.store.directory, "admission.lock"), async () => {
      const m = await this.store.read()
      if (m.revision !== expectedRevision) throw new SupervisionError("conflict")
      if (m.desired === "unset") return
      let agent = await this.ownedAgent(), loaded = await this.loaded(agent)
      if (m.desired === "on") {
        // LaunchAgents is shared with unrelated apps. Check the real directory
        // chain without changing its permissions, then create only our leaf.
        await preparePosixSupervisionDirectory(this.runtime.agentDirectory)
        if (await realpath(this.runtime.agentDirectory) !== this.runtime.agentDirectory) throw new SupervisionError("unsafe-storage")
        if (!agent.exists) {
          const handle = await open(agent.file, "wx", 0o600)
          try { await handle.writeFile(agent.text); await handle.sync() } finally { await handle.close() }
        }
        agent = await this.ownedAgent()
        if (!loaded) {
          const result = await this.command(["bootstrap", `gui/${m.namespace.user}`, agent.file])
          if (result.code) throw new SupervisionError("busy")
        }
        if (!await this.loaded(agent)) throw new SupervisionError("busy")
      } else {
        if (loaded) {
          const result = await this.command(["bootout", agent.target])
          if (result.code) throw new SupervisionError("busy")
        }
        const deadline = Date.now() + 15_000
        while (await this.loaded(agent)) {
          if (Date.now() >= deadline) throw new SupervisionError("busy")
          await delay(100)
        }
        // AbandonProcessGroup leaves the released child intact, even if launchd
        // escalates termination of the foreground guard. Never signal OpenCode.
        if (loaded?.pid) {
          while ((await lookupMacosProcess(loaded.pid, this.runtime.nativeHelper)).state !== "dead") {
            if (Date.now() >= deadline) throw new SupervisionError("busy")
            await delay(100)
          }
        }
        agent = await this.ownedAgent()
        if (agent.exists) await unlink(agent.file)
      }
    }, this.policy, this.runtime.nativeHelper)
    await this.store.acknowledge(expectedRevision)
  }
  async observe(): Promise<SupervisionObservation> {
    const m = await this.store.read(), lookup = (pid: number) => lookupMacosProcess(pid, this.runtime.nativeHelper)
    const health = await readSupervisionHealth(path.join(m.namespace.stateDirectory, m.namespace.registrationName), { lookup })
    let resources: SupervisionObservation["resources"] = "unknown", guard: SupervisionObservation["guard"] = "unknown"
    let detail: SupervisionObservation["detail"], artifactMissing = false
    for (const file of [this.runtime.node, this.runtime.guard, this.runtime.nativeHelper]) {
      try { await this.policy.verify(file, false) } catch { artifactMissing = true }
    }
    try {
      const agent = await this.ownedAgent(), loaded = await this.loaded(agent)
      resources = !agent.exists && !loaded ? "absent" : agent.exists && loaded ? "installed" : "unknown"
      guard = !loaded || !loaded.pid ? "absent" : "unknown"
      if (loaded?.pid && loaded.state === "running") {
        const status = z.object({ key: z.literal(m.key), revision: z.literal(m.revision), guardPid: z.literal(loaded.pid), guardStart: z.string(),
          cause: z.enum(["native-service-disabled-or-unknown", "start-failed", "service-unknown"]).nullable(),
          lastAttemptAt: z.string().datetime().optional(), retryAt: z.string().datetime().optional(),
        }).passthrough().parse(await readPrivate(path.join(this.store.directory, "macos-status.json"), this.policy))
        const owner = await lookup(loaded.pid)
        if (owner.state === "live" && owner.startIdentity === status.guardStart) {
          guard = "active"; detail = { cause: status.cause, lastAttemptAt: status.lastAttemptAt, retryAt: status.retryAt }
        }
      }
    } catch { /* Missing/partial ownership and native status evidence stays unknown. */ }
    return { revision: m.revision, resources, guard, health, artifactMissing, ...(detail ? { detail } : {}) }
  }
}
