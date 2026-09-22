import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import {
  PLUGIN_CONTROL_MAX_CONFIG_BYTES,
  PluginControlDocumentError,
  type PluginControlDocument,
  type PluginControlDocumentFileSystem,
  type PluginControlDocumentLoad,
  type PluginControlDocumentReplaceOptions,
} from "./plugin-control-document"

const COMMAND_TIMEOUT_MS = 10_000
const LOCK_WAIT_MS = 2_000
const LOCK_STALE_SECONDS = 30
const OUTPUT_ALLOWANCE = 64 * 1024

const INSPECT_SCRIPT = String.raw`# inspect-document
set -eu
resolve_one() {
  realpath -m -- "$1" 2>/dev/null || realpath -- "$1" 2>/dev/null || exit 66
}
for requested do
  target=$(resolve_one "$requested")
  if [ -L "$target" ]; then exit 66; fi
  if [ -e "$target" ]; then
    [ -f "$target" ] || exit 66
    printf 'file\0%s\0' "$target"
  else
    printf 'missing\0%s\0' "$target"
  fi
done
`

const READ_SCRIPT = String.raw`# read-document
set -eu
resolve_one() {
  realpath -m -- "$1" 2>/dev/null || realpath -- "$1" 2>/dev/null || exit 66
}
target=$(resolve_one "$1")
if [ -L "$target" ]; then exit 66; fi
maximum=$2
if [ ! -e "$target" ]; then
  printf 'missing\0%s\0\0' "$target"
  exit 0
fi
[ -f "$target" ] || exit 66
size=$(stat -c '%s' -- "$target" 2>/dev/null || stat -f '%z' -- "$target" 2>/dev/null || exit 66)
[ "$size" -le "$maximum" ] || exit 77
mode=$(stat -c '%a' -- "$target" 2>/dev/null || stat -f '%p' -- "$target" 2>/dev/null || exit 66)
printf 'file\0%s\0%s\0' "$target" "$mode"
cat -- "$target"
`

const PREPARE_SCRIPT = String.raw`# prepare-document
set -eu
directory=$1
target=$2
temporary=$3
lock=$4
nonce=$5
mode=$6
expectedMode=$7
existed=$8
expected=$9
stale=${10}
deadlineMs=${11}
hash_of() {
  result=$(sha256sum -- "$1" 2>/dev/null | awk '{print $1}') && [ -n "$result" ] && printf '%s' "$result" && return 0
  result=$(shasum -a 256 -- "$1" 2>/dev/null | awk '{print $1}') && [ -n "$result" ] && printf '%s' "$result" && return 0
  return 1
}
mode_of() {
  stat -c '%a' -- "$1" 2>/dev/null || stat -f '%p' -- "$1" 2>/dev/null || return 1
}
locked=0
cleanup() {
  rm -f -- "$temporary"
  if [ "$locked" = 1 ]; then
    current=$(cat -- "$lock/owner" 2>/dev/null || true)
    if [ "$current" = "$nonce" ]; then rm -rf -- "$lock" 2>/dev/null || true; fi
  fi
}
trap cleanup EXIT
mkdir -p -- "$directory"
umask 077
( set -C; : > "$temporary" ) 2>/dev/null || exit 76
chmod "$mode" "$temporary"
cat > "$temporary"
chmod "$mode" "$temporary"
sync -d "$temporary" 2>/dev/null || sync 2>/dev/null || true
deadline=$(( $(date +%s) + (deadlineMs + 999) / 1000 ))
while ! mkdir -m 700 -- "$lock" 2>/dev/null; do
  now=$(date +%s)
  modified=$(stat -c '%Y' -- "$lock" 2>/dev/null || stat -f '%m' -- "$lock" 2>/dev/null || printf '%s' "$now")
  if [ $((now - modified)) -gt "$stale" ]; then rm -rf -- "$lock" 2>/dev/null || true; fi
  [ "$(date +%s)" -lt "$deadline" ] || exit 75
  sleep 0.02 2>/dev/null || sleep 0 2>/dev/null || true
done
printf '%s' "$nonce" > "$lock/owner"
chmod 600 -- "$lock/owner"
locked=1
if [ "$existed" = 1 ]; then
  [ -f "$target" ] || exit 73
  actual=$(hash_of "$target") || exit 66
  [ "$actual" = "$expected" ] || exit 73
  currentMode=$(mode_of "$target") || exit 66
  [ "$currentMode" = "$expectedMode" ] || exit 73
else
  [ ! -e "$target" ] || exit 73
fi
trap - EXIT
`

const COMMIT_SCRIPT = String.raw`# commit-document
set -eu
target=$1
existed=$2
expected=$3
temporary=$4
lock=$5
nonce=$6
mode=$7
expectedMode=$8
hash_of() {
  result=$(sha256sum -- "$1" 2>/dev/null | awk '{print $1}') && [ -n "$result" ] && printf '%s' "$result" && return 0
  result=$(shasum -a 256 -- "$1" 2>/dev/null | awk '{print $1}') && [ -n "$result" ] && printf '%s' "$result" && return 0
  return 1
}
mode_of() {
  stat -c '%a' -- "$1" 2>/dev/null || stat -f '%p' -- "$1" 2>/dev/null || return 1
}
cleanup() {
  rm -f -- "$temporary"
  current=$(cat -- "$lock/owner" 2>/dev/null || true)
  if [ "$current" = "$nonce" ]; then rm -rf -- "$lock" 2>/dev/null || true; fi
}
trap cleanup EXIT
[ -d "$lock" ] || exit 75
current=$(cat -- "$lock/owner" 2>/dev/null || true)
[ "$current" = "$nonce" ] || exit 75
if [ "$existed" = 1 ]; then
  [ -f "$target" ] || exit 73
  actual=$(hash_of "$target") || exit 66
  [ "$actual" = "$expected" ] || exit 73
  currentMode=$(mode_of "$target") || exit 66
  [ "$currentMode" = "$expectedMode" ] || exit 73
else
  [ ! -e "$target" ] || exit 73
fi
mv -T -f -- "$temporary" "$target" 2>/dev/null || {
  if [ -d "$target" ]; then exit 73; fi
  mv -f -- "$temporary" "$target"
}
if [ ! -f "$target" ] || [ -e "$temporary" ]; then
  rm -f -- "$target/$(basename -- "$temporary")" 2>/dev/null || true
  rm -f -- "$temporary" 2>/dev/null || true
  exit 73
fi
sync -d "$target" 2>/dev/null || sync 2>/dev/null || true
`

const CLEANUP_SCRIPT = String.raw`# cleanup-document
set -eu
temporary=$1
lock=$2
nonce=$3
rm -f -- "$temporary"
current=$(cat -- "$lock/owner" 2>/dev/null || true)
if [ "$current" = "$nonce" ]; then rm -rf -- "$lock" 2>/dev/null || true; fi
`

export interface WslPluginControlExecution {
  status: number | null
  stdout: Buffer
  stderr: Buffer
  error?: Error
}

export type WslPluginControlExecutor = (
  distro: string,
  script: string,
  args: readonly string[],
  input?: Buffer,
  maxBuffer?: number,
) => Promise<WslPluginControlExecution>

export function createWslPluginControlDocumentFileSystem(
  distro: string,
  execute: WslPluginControlExecutor = executeWslScript,
): PluginControlDocumentFileSystem {
  const run = (script: string, args: readonly string[], input?: Buffer, maxBuffer?: number) => (
    execute(distro, script, args, input, maxBuffer)
  )

  const load = async (requestedPath: string): Promise<PluginControlDocumentLoad> => {
    assertNativePath(requestedPath)
    const result = await run(
      READ_SCRIPT,
      [requestedPath, String(PLUGIN_CONTROL_MAX_CONFIG_BYTES)],
      undefined,
      PLUGIN_CONTROL_MAX_CONFIG_BYTES + OUTPUT_ALLOWANCE,
    )
    if (result.status === 77) throw new PluginControlDocumentError("OpenCode configuration file is too large", "invalid")
    assertSuccess(result, "Unable to read OpenCode configuration in WSL")
    const [status, resolved, mode, contents] = splitNullFields(result.stdout, 3, true)
    const writePath = resolved.toString("utf8")
    assertNativePath(writePath)
    if (status.equals(Buffer.from("missing"))) {
      return { writePath, exists: false, mode: 0o600, contents: Buffer.from("{}\n") }
    }
    if (!status.equals(Buffer.from("file"))) throw filesystemError("Invalid WSL configuration response")
    const parsedMode = Number.parseInt(mode.toString("ascii"), 8)
    if (!Number.isInteger(parsedMode) || parsedMode < 0 || parsedMode > 0o777) {
      throw filesystemError("Invalid WSL configuration permissions")
    }
    if (contents.length > PLUGIN_CONTROL_MAX_CONFIG_BYTES) {
      throw new PluginControlDocumentError("OpenCode configuration file is too large", "invalid")
    }
    return { writePath, exists: true, mode: parsedMode, contents }
  }

  const inspectMany = async (requestedPaths: readonly string[]) => {
    requestedPaths.forEach(assertNativePath)
    const result = await run(INSPECT_SCRIPT, requestedPaths)
    assertSuccess(result, "Unable to inspect OpenCode configuration in WSL")
    const fields = splitNullFields(result.stdout, requestedPaths.length * 2)
    return requestedPaths.map((_, index) => {
      const status = fields[index * 2]!
      const writePath = fields[index * 2 + 1]!.toString("utf8")
      assertNativePath(writePath)
      if (!status.equals(Buffer.from("file")) && !status.equals(Buffer.from("missing"))) {
        throw filesystemError("Invalid WSL configuration response")
      }
      return { writePath, exists: status.equals(Buffer.from("file")) }
    })
  }

  const replace = async (
    document: PluginControlDocument,
    updated: string,
    options?: PluginControlDocumentReplaceOptions,
  ) => {
    assertNativePath(document.writePath)
    const directory = path.posix.dirname(document.writePath)
    const suffix = `${process.pid}.${randomBytes(8).toString("hex")}`
    const temporary = `${document.writePath}.${suffix}.tmp`
    const lock = `${document.writePath}.codenomad-plugin-controls.lock`
    const nonce = randomBytes(16).toString("hex")
    const mode = document.mode.toString(8).padStart(3, "0")
    const expected = createHash("sha256").update(encodeOriginal(document)).digest("hex")
    let locked = false
    try {
      const prepared = await run(PREPARE_SCRIPT, [
        directory,
        document.writePath,
        temporary,
        lock,
        nonce,
        mode,
        mode,
        document.exists ? "1" : "0",
        expected,
        String(LOCK_STALE_SECONDS),
        String(LOCK_WAIT_MS),
      ], Buffer.from(updated, "utf8"))
      if (prepared.status === 73) throw changedError()
      if (prepared.status === 75) {
        throw new PluginControlDocumentError("OpenCode configuration is being updated by another process", "conflict")
      }
      assertSuccess(prepared, "Unable to prepare OpenCode configuration in WSL")
      locked = true
      try {
        options?.beforeCommit?.()
      } catch (error) {
        throw new PluginControlDocumentError("OpenCode configuration replacement is no longer authorized", "filesystem", { cause: error })
      }
      const committed = await run(COMMIT_SCRIPT, [
        document.writePath,
        document.exists ? "1" : "0",
        expected,
        temporary,
        lock,
        nonce,
        mode,
        mode,
      ])
      if (committed.status !== null) locked = false
      if (committed.status === 73) throw changedError()
      if (committed.status === 75) {
        throw new PluginControlDocumentError("OpenCode configuration lock was lost before the atomic rename", "conflict")
      }
      assertSuccess(committed, "Unable to atomically replace OpenCode configuration in WSL")
    } finally {
      if (locked) await run(CLEANUP_SCRIPT, [temporary, lock, nonce]).catch(() => undefined)
    }
  }

  return { inspectMany, load, replace }
}

function splitNullFields(buffer: Buffer, count: number, includeRemainder = false): Buffer[] {
  const fields: Buffer[] = []
  let start = 0
  for (let index = 0; index < count; index++) {
    const end = buffer.indexOf(0, start)
    if (end < 0) throw filesystemError("Invalid WSL configuration response")
    fields.push(buffer.subarray(start, end))
    start = end + 1
  }
  if (includeRemainder) fields.push(buffer.subarray(start))
  return fields
}

function assertSuccess(result: WslPluginControlExecution, message: string): void {
  if (result.status === 0 && !result.error) return
  throw filesystemError(message, result.error ?? new Error(result.stderr.toString("utf8").trim() || `exit ${result.status}`))
}

function assertNativePath(value: string): void {
  if (!path.posix.isAbsolute(value) || value.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(value)) {
    throw filesystemError("Invalid native WSL configuration path")
  }
}

function changedError(): PluginControlDocumentError {
  return new PluginControlDocumentError("OpenCode configuration changed during the update", "conflict")
}

function filesystemError(message: string, cause?: unknown): PluginControlDocumentError {
  return new PluginControlDocumentError(message, "filesystem", cause === undefined ? undefined : { cause })
}

function encodeOriginal(document: PluginControlDocument): Buffer {
  return Buffer.from(`${document.byteOrderMark ? "\uFEFF" : ""}${document.text}`, "utf8")
}

function executeWslScript(
  distro: string,
  script: string,
  args: readonly string[],
  input?: Buffer,
  maxBuffer = OUTPUT_ALLOWANCE,
): Promise<WslPluginControlExecution> {
  return new Promise((resolve) => {
    const child = execFile(
      "wsl.exe",
      ["--distribution", distro, "--exec", "sh", "-c", script, "codenomad-plugin-controls", ...args],
      { encoding: null, windowsHide: true, timeout: COMMAND_TIMEOUT_MS, maxBuffer },
      (error, stdout, stderr) => {
        const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? null : 0
        resolve({
          status: code,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
          ...(error ? { error } : {}),
        })
      },
    )
    child.stdin?.end(input)
  })
}
