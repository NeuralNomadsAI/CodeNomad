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
function check(expected) {
  for (const scenario of cases) {
    const result = spawnSync(binary, [scenario], { cwd: fixture, env, encoding: "utf8", timeout: 15_000, windowsHide: true })
    assert.equal(result.error, undefined, `${scenario}: ${result.error}`)
    assert.match(result.stdout, /nested focus queued before Tao input processing/, `${scenario}: ${result.stdout}${result.stderr}`)
    assert.equal(result.status, expected, `${scenario}: ${result.stdout}${result.stderr}`)
    if (expected === 0) assert.match(result.stdout, /PASS:/)
    else assert.match(result.stderr, /input callback watchdog/)
    console.log(`${expected === 0 ? "fixed PASS" : "original deadlock reproduced"}: ${scenario}`)
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
