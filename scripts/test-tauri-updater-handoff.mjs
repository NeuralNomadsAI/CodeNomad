// Vendored updater launch handoff regression. Cargo refuses to test a non-member
// path patch with dev-dependencies, and membership would lock every optional
// feature, so a temporary copy runs as its own package with its published lockfile.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

assert.equal(process.platform, "win32", "Run this native regression on Windows")
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workspace = path.join(root, "packages/tauri-app")
const target = path.resolve(process.env.CARGO_TARGET_DIR || path.join(workspace, "target"))
const env = { ...process.env, CARGO_TARGET_DIR: target }
delete env.NODE_OPTIONS
function cargo(args, cwd) {
  const result = spawnSync("cargo", args, { cwd, env, encoding: "utf8", timeout: 900_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}

const metadata = JSON.parse(cargo(["metadata", "--locked", "--format-version", "1"], workspace))
const updater = metadata.packages.filter(item => item.name === "tauri-plugin-updater")
assert.equal(updater.length, 1, "The application must resolve one updater implementation")
const vendored = path.join(workspace, `vendor/tauri-plugin-updater-${updater[0].version}`)
assert.equal(path.resolve(updater[0].manifest_path), path.join(vendored, "Cargo.toml"))

const temporaryRoot = path.join(os.tmpdir(), "opencode")
await mkdir(temporaryRoot, { recursive: true })
const copy = await mkdtemp(path.join(temporaryRoot, "tauri-updater-handoff-"))
try {
  await cp(vendored, copy, { recursive: true })
  const output = cargo(["test", "--locked", "--lib", "windows_launch_tests"], copy)
  assert.match(output, /test updater::windows_launch_tests::failed_launch_preserves_ownership_and_success_releases_once \.\.\. ok/)
  assert.match(output, /test result: ok\. 1 passed/)
  console.log("PASS: installer handoff releases ownership only after a successful launch")
} finally {
  await rm(copy, { recursive: true, force: true })
}
