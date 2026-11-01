import { execFile } from "node:child_process"
import path from "node:path"
import { z } from "zod"
import { Service } from "@opencode/client/service"
import type { ProcessLookup } from "./process-identity"
import { nativeSupervisionStartPermitted, readSupervisionSample } from "./service-supervision-health"
import type { SupervisionManifest } from "./service-supervision-contract"
import { readNativeScheduleIncarnation } from "../opencode/missions/native-schedule-transport-identity"
import { supervisionTargetReady } from "./service-supervision-target"

const linuxPath = z.string().min(1).max(4096).refine(value => value.startsWith("/")
  && path.posix.normalize(value) === value && !/[\\\x00-\x1f\x7f]/.test(value))
export const wslRuntimeSchema = z.object({
  executable: z.string().max(4096).refine(value => /^[A-Za-z]:\\/.test(value)
    && path.win32.normalize(value) === value && !/[\x00-\x1f"]/.test(value) && !value.slice(2).includes(":")),
  distro: z.string().min(1).max(240).regex(/^[^\\/\x00-\x1f"]+$/),
  user: z.string().regex(/^(?:0|[1-9]\d*)$/),
  account: z.string().min(1).max(256).regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/),
  owner: z.string().regex(/^S-1-\d+(?:-\d+)+$/),
  manifest: linuxPath,
  environment: z.object({ HOME: linuxPath, XDG_CONFIG_HOME: linuxPath, XDG_STATE_HOME: linuxPath,
    XDG_DATA_HOME: linuxPath, XDG_CACHE_HOME: linuxPath, OPENCODE_TEST_HOME: linuxPath.optional() }).strict(),
}).strict()
export type WslSupervisionRuntime = z.infer<typeof wslRuntimeSchema>

/** Exact distro/UID, fixed argv, no shell interpolation or Windows PID operations. */
export function runSupervisionWsl(runtime: Pick<WslSupervisionRuntime, "executable" | "distro"> & { account?: string }, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => execFile(runtime.executable,
    ["--distribution", runtime.distro, ...(runtime.account ? ["--user", runtime.account] : []), "--exec", ...args],
    { windowsHide: true, timeout, maxBuffer: 65536, encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE,
        LOCALAPPDATA: process.env.LOCALAPPDATA } },
    (error, stdout) => error ? reject(new Error("supervision-wsl-unavailable")) : resolve(stdout.trim())))
}

export function wslSupervisionLookup(runtime: WslSupervisionRuntime): ProcessLookup {
  return async pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" }
    try {
      const text = await runSupervisionWsl(runtime, ["/bin/sh", "-c",
        'if [ ! -d "/proc/$1" ]; then printf DEAD; else cat "/proc/$1/stat" /proc/sys/kernel/random/boot_id; fi', "codenomad-process", String(pid)])
      if (text === "DEAD") return { state: "dead" }
      const [stat, boot] = text.split("\n")
      const fields = stat?.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
      if (!fields || !/^\d+$/.test(fields[19] ?? "") || !/^[a-f0-9-]{36}$/.test(boot ?? "")) return { state: "unknown" }
      if (fields[0] === "Z" || fields[0] === "X") return { state: "dead" }
      return { state: "live", startIdentity: `linux:${boot}:${fields[19]}` }
    } catch { return { state: "unknown" } }
  }
}

export async function wslSupervisionPaths(manifest: SupervisionManifest, runtime: WslSupervisionRuntime) {
  const n = manifest.namespace
  if (n.platform !== "wsl" || n.user !== runtime.user || n.distro !== runtime.distro
    || path.posix.join(runtime.environment.XDG_CONFIG_HOME, "opencode") !== n.configDirectory
    || path.posix.join(runtime.environment.XDG_STATE_HOME, "opencode") !== n.stateDirectory) throw new Error("supervision-wsl-namespace")
  // One bounded native inspection keeps the guard's probe deadline independent
  // of the startup cost of multiple wsl.exe clients.
  const rows = (await runSupervisionWsl(runtime, ["/bin/sh", "-c",
    'set -eu; /usr/bin/id -u; for p in "$@"; do /usr/bin/readlink -e -- "$p"; /usr/bin/wslpath -w "$p"; done',
    "codenomad-namespace", n.configDirectory, n.stateDirectory])).split(/\r?\n/)
  if (rows.length !== 5 || rows[0] !== n.user || rows[1] !== n.configDirectory || rows[3] !== n.stateDirectory
    || [rows[2]!, rows[4]!].some(host => !path.win32.isAbsolute(host) || /[\r\n\x00]/.test(host))) throw new Error("supervision-wsl-namespace")
  return { config: path.win32.join(rows[2]!, n.registrationName), registration: path.win32.join(rows[4]!, n.registrationName) }
}

/** Discovery runs from Windows: a healthy result also proves authenticated
 * localhost forwarding. An unreachable live Linux PID never authorizes a spawn. */
export async function readWslSupervisionSample(manifest: SupervisionManifest, runtime: WslSupervisionRuntime,
  discover: typeof Service.discover = Service.discover, checkTarget = false) {
  const files = await wslSupervisionPaths(manifest, runtime)
  const { health, identity } = await readSupervisionSample(files.registration, { lookup: wslSupervisionLookup(runtime), discover })
  const permitted = await nativeSupervisionStartPermitted(files.config)
  let forwardingUnavailable = false
  if (health.state === "unhealthy") {
    // The official CLI's status is read-only and probes from Linux. A native
    // healthy URL plus failed Windows discovery isolates the forwarding path;
    // timeout/500/unknown inside Linux keeps ordinary unknown health instead.
    const native = await runSupervisionWsl(runtime, ["/usr/bin/env", "-i",
      ...Object.entries(runtime.environment).map(([key, value]) => `${key}=${value}`),
      "PATH=/usr/bin:/bin", manifest.target.binary, "service", "status"], 3000).catch(() => undefined)
    forwardingUnavailable = native !== undefined && native === readNativeScheduleIncarnation(files.registration).url
  }
  return { revision: manifest.revision, desired: manifest.desired, binary: manifest.target.binary, health, identity, permitted,
    ...(checkTarget ? { targetReady: await supervisionTargetReady(manifest.target,
      file => runSupervisionWsl(runtime, ["/usr/bin/wslpath", "-w", file]), { namespace: manifest.namespace,
        run: args => runSupervisionWsl(runtime, ["/usr/bin/env", "-i", ...Object.entries(runtime.environment).map(([key, value]) => `${key}=${value}`),
          "PATH=/usr/bin:/bin", manifest.target.binary, ...args], 2000) }) } : {}),
    forwardingUnavailable, launch: wslSupervisionLaunch(runtime, manifest.target.binary, manifest.revision) }
}

/** The fixed shell is the Linux foreground bridge. Ignored HUP is inherited by
 * managed OpenCode; independent stdio and the Windows handle release preserve it
 * at OFF. ON keeps the wsl.exe client resident and observes its real exit. */
export function wslSupervisionLaunch(runtime: WslSupervisionRuntime, binary: string, revision: number): string[] {
  if (!linuxPath.safeParse(binary).success || !Number.isSafeInteger(revision) || revision < 0) throw new Error("supervision-wsl-binary")
  return ["--distribution", runtime.distro, "--user", runtime.account, "--exec", "/bin/sh", "-c",
    // The fixed JSON token is only a release hint from our atomic private
    // manifest, never admission authority. Windows owns the Start exclusion.
    'trap "" HUP; manifest=$1; user=$2; home=$3; revision=$4; lock=$5; shift 5; [ "$(/usr/bin/id -u)" = "$user" ] && cd "$home" || exit 1; on() { /usr/bin/grep -Fq \'"desired":"on"\' "$manifest"; }; exec 9>>"$lock"; /usr/bin/flock -x 9 || exit 1; on && /usr/bin/grep -Fq "\\"revision\\":$revision,\\"desired\\":\\"on\\"" "$manifest" || exit 0; /usr/bin/env -i "$@" 9>&- </dev/null >/dev/null 2>&1 & child=$!; exec 9>&-; while kill -0 "$child" 2>/dev/null; do on || exit 0; /bin/sleep 1; done; wait "$child"',
    "codenomad-foreground", runtime.manifest, runtime.user, runtime.environment.HOME, String(revision),
    path.posix.join(path.posix.dirname(runtime.manifest), "linux-admission.lock"),
    ...Object.entries(runtime.environment).map(([key, value]) => `${key}=${value}`), "PATH=/usr/bin:/bin", "LANG=C.UTF-8", binary, "serve", "--service"]
}
