// Real Win32/Tao input reentrancy. No CodeNomad profile, backend or shared daemon.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

assert.equal(process.platform, "win32", "Run this native regression on Windows")
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workspace = path.join(root, "packages/tauri-app")
const fixture = path.join(workspace, "tests/windows-input")
const target = path.resolve(process.env.CARGO_TARGET_DIR || path.join(workspace, "target"))
const env = { ...process.env, CARGO_TARGET_DIR: target }
delete env.NODE_OPTIONS
delete env.CODENOMAD_NATIVE_PARENT
function cargo(args, cwd = workspace) {
  const result = spawnSync("cargo", args, { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}
const binary = path.join(target, "debug/codenomad-windows-input-fixture.exe")
const cases = ["keydown", "keyup", "char", "syschar", "ime"]
function check(expected, scenarios = cases) {
  for (const scenario of scenarios) {
    const result = spawnSync(binary, [scenario], { cwd: fixture, env, encoding: "utf8", timeout: 15_000, windowsHide: true })
    assert.equal(result.error, undefined, `${scenario}: ${result.error}`)
    assert.match(result.stdout, /nested focus queued before Tao input processing/, `${scenario}: ${result.stdout}${result.stderr}`)
    assert.equal(result.status, expected, `${scenario}: ${result.stdout}${result.stderr}`)
    if (expected === 0) assert.match(result.stdout, /PASS:/)
    else assert.match(result.stderr, /input callback watchdog/)
    console.log(`${expected === 0 ? "fixed PASS" : "negative control deadlock reproduced"}: ${scenario}`)
  }
}

// Optional negative control downloads the original published crate through Cargo.
// Build it in a separate temporary workspace so the production patch is untouched.
if (process.argv.includes("--baseline")) {
  const temporaryRoot = path.join(os.tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  const baseline = await mkdtemp(path.join(temporaryRoot, "tao-input-baseline-"))
  try {
    await cp(path.join(fixture, "src"), path.join(baseline, "src"), { recursive: true })
    await writeFile(path.join(baseline, "Cargo.toml"), (await readFile(path.join(fixture, "Cargo.toml"), "utf8")) + "\n[workspace]\n")
    cargo(["build", "--manifest-path", path.join(baseline, "Cargo.toml")], baseline)
    check(2)
  } finally { await rm(baseline, { recursive: true, force: true }) }
}

const metadata = JSON.parse(cargo(["metadata", "--locked", "--format-version", "1"]))
const tao = metadata.packages.filter(item => item.name === "tao")
assert.equal(tao.length, 1, "Tauri and the regression must share one Tao implementation")
assert.equal(path.resolve(tao[0].manifest_path), path.join(workspace, "vendor/tao-0.34.6/Cargo.toml"))
cargo(["build", "--locked", "-p", "codenomad-windows-input-fixture"])
check(0)

// Queue at the IME boundary itself: the keyboard pre-peek must not consume the
// sent focus message first. Instrument ONLY a temporary copy, preserving every
// production statement and the checked-in upstream source byte-for-byte.
const temporaryRoot = path.join(os.tmpdir(), "opencode")
await mkdir(temporaryRoot, { recursive: true })
const imeRoot = await mkdtemp(path.join(temporaryRoot, "tao-ime-boundary-"))
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one instrumentation boundary: ${before}`)
  return source.replace(before, after)
}
try {
  await cp(path.join(fixture, "src"), path.join(imeRoot, "src"), { recursive: true })
  await cp(path.join(workspace, "vendor/tao-0.34.6"), path.join(imeRoot, "tao"), { recursive: true })
  await writeFile(path.join(imeRoot, "Cargo.toml"),
    (await readFile(path.join(fixture, "Cargo.toml"), "utf8")) + '\n[workspace]\n[patch.crates-io]\ntao = { path = "tao" }\n')
  const eventLoop = path.join(imeRoot, "tao/src/platform_impl/windows/event_loop.rs")
  const original = (await readFile(eventLoop, "utf8")).replaceAll("\r\n", "\n")
  const instrumented = replaceOnce(original, "  let ime_callback = || {", `  let ime_callback = || {
    if matches!(msg, WM_CHAR | WM_SYSCHAR) {
      unsafe { SendMessageW(window, WM_APP + 0x434, None, None); }
    }`)
  await writeFile(eventLoop, instrumented)
  cargo(["build", "--manifest-path", path.join(imeRoot, "Cargo.toml")], imeRoot)
  check(0, ["ime-boundary"])

  // Mutation control: only move the real IME peek back under window_state.
  // This must hang even though keyboard input still uses the upstream fix.
  const peek = "    let more_char_coming = more_ime_char_coming(window, msg);\n"
  const lock = "    let text = {\n      let mut window_state = subclass_input.window_state.lock();\n"
  const mutated = replaceOnce(replaceOnce(instrumented, peek, ""), lock, lock + peek)
  await writeFile(eventLoop, mutated)
  cargo(["build", "--locked", "--manifest-path", path.join(imeRoot, "Cargo.toml")], imeRoot)
  check(2, ["ime-boundary"])
} finally {
  await rm(imeRoot, { recursive: true, force: true })
}
