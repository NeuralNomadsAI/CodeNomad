import { spawn } from "node:child_process"
import path from "node:path"
import { SupervisionError, SUPERVISION_MANIFEST_BYTES } from "./service-supervision-contract"
import { wslRuntimeSchema, type WslSupervisionRuntime } from "./service-supervision-wsl"

/** The Linux lock holder also publishes. Its death closes publication authority:
 * a late Windows callback has only a broken pipe, never filesystem write access.
 * Fork admission and every manifest writer share this descriptor lock. */
export async function mutateWslSupervisionFile(runtime: WslSupervisionRuntime,
  update: (bytes: string | null) => Promise<string>, launch: typeof spawn = spawn): Promise<void> {
  const d = wslRuntimeSchema.parse(runtime), directory = path.posix.dirname(d.manifest)
  const script = `set -eu; umask 077; file=$1; lock=$2; user=$3; tmp=
    [ "$(/usr/bin/id -u)" = "$user" ] || exit 1
    exec 9>>"$lock"; /usr/bin/flock -xn 9 || exit 1
    trap 'test -z "$tmp" || /bin/rm -f -- "$tmp"' EXIT
    if [ -e "$file" ]; then
      [ -f "$file" ] && [ ! -L "$file" ] && [ "$(/usr/bin/wc -c <"$file")" -le ${SUPERVISION_MANIFEST_BYTES} ] || exit 1
      printf 'READY:'; /usr/bin/base64 -w0 -- "$file"; printf '\\n'
    else printf 'READY:-\\n'; fi
    IFS= read -r next || exit 1
    [ "\${#next}" -le 90000 ] || exit 1
    case "$next" in *[!A-Za-z0-9+/=]*) exit 1;; esac
    tmp=$(/usr/bin/mktemp "$(/usr/bin/dirname -- "$file")/.manifest-XXXXXXXX")
    printf '%s' "$next" | /usr/bin/base64 -d >"$tmp"
    [ "$(/usr/bin/wc -c <"$tmp")" -le ${SUPERVISION_MANIFEST_BYTES} ] || exit 1
    /usr/bin/sync -f "$tmp"; /bin/mv -fT -- "$tmp" "$file"; tmp=
    /usr/bin/sync -f "$(/usr/bin/dirname -- "$file")"
    printf 'COMMITTED\\n'`
  const child = launch(d.executable, ["--distribution", d.distro, "--user", d.account, "--exec", "/bin/sh", "-c",
    script, "codenomad-mutation", d.manifest, path.posix.join(directory, "linux-admission.lock"), d.user], {
    windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA },
  })
  const exit = new Promise<number | null>(resolve => { child.once("exit", resolve); child.once("error", () => resolve(null)) })
  child.stdin!.on("error", () => {})
  let output = "", requested = false, committed = false
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new SupervisionError("busy")))
      child.once("exit", () => { if (!committed) reject(new SupervisionError("busy")) })
      child.stdout!.on("data", bytes => {
        output += bytes.toString("utf8")
        if (output.length > 100_000) { reject(new SupervisionError("invalid")); child.kill(); return }
        const lines = output.split(/\r?\n/)
        if (!requested && lines.length > 1) {
          requested = true
          if (!lines[0]!.startsWith("READY:")) { reject(new SupervisionError("invalid")); return }
          const data = lines[0]!.slice(6)
          void update(data === "-" ? null : Buffer.from(data, "base64").toString("utf8")).then(next => {
            if (child.exitCode !== null || child.killed) return
            if (Buffer.byteLength(next) > SUPERVISION_MANIFEST_BYTES) throw new SupervisionError("invalid")
            child.stdin!.end(Buffer.from(next).toString("base64") + "\n")
          }).catch(reject)
        }
        if (lines.includes("COMMITTED")) { committed = true; resolve() }
      })
    })
    if (await exit !== 0) throw new SupervisionError("busy")
  } finally {
    child.stdin!.end()
    if (!committed) child.kill()
    await exit
    clearTimeout(timer)
  }
}
