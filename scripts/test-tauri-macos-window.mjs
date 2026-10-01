// Real AppKit/Tao event feedback. Never opens user profiles or OpenCode.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

assert.equal(process.platform, "darwin", "Run this regression in a graphical macOS session")
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workspace = path.join(root, "packages/tauri-app")
const fixture = path.join(workspace, "tests/macos-window")
const target = path.resolve(process.env.CARGO_TARGET_DIR || path.join(workspace, "target"))
const env = { ...process.env, CARGO_TARGET_DIR: target }
delete env.NODE_OPTIONS
delete env.CODENOMAD_NATIVE_PARENT
function cargo(args, cwd = workspace) {
  const result = spawnSync("cargo", args, { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}
function check(baseline = false) {
  const binary = path.join(target, "debug/codenomad-macos-window-fixture")
  const result = spawnSync(binary, [], { cwd: fixture, env, encoding: "utf8", timeout: 30_000 })
  assert.equal(result.error, undefined, String(result.error))
  if (baseline) {
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stderr, /native window event feedback watchdog|reads generated geometry events/)
    console.log("PASS: original Tao getter reproduced geometry event feedback")
  } else {
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /PASS: read-only zoom checks/)
    console.log(result.stdout.trim())
  }
}
if (process.argv.includes("--baseline")) {
  const baseline = await mkdtemp(path.join(os.tmpdir(), "codenomad-macos-zoom-baseline-"))
  await cp(path.join(fixture, "src"), path.join(baseline, "src"), { recursive: true })
  await writeFile(path.join(baseline, "Cargo.toml"), (await readFile(path.join(fixture, "Cargo.toml"), "utf8")) + "\n[workspace]\n")
  cargo(["build", "--manifest-path", path.join(baseline, "Cargo.toml")], baseline)
  // The baseline may exit via the watchdog or the bounded event assertion.
  check(true)
}
const metadata = JSON.parse(cargo(["metadata", "--locked", "--format-version", "1"]))
const tao = metadata.packages.filter(item => item.name === "tao")
assert.equal(tao.length, 1)
assert.equal(path.resolve(tao[0].manifest_path), path.join(workspace, "vendor/tao-0.34.6/Cargo.toml"))
cargo(["build", "--locked", "-p", "codenomad-macos-window-fixture"])
check()
