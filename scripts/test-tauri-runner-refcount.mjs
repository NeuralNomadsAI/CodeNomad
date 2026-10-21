// Real Wry handle cloning. No CodeNomad profile, backend, page or shared daemon.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

assert.equal(process.platform, "win32", "Run this native regression on Windows")
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workspace = path.join(root, "packages/tauri-app")
const fixture = "tests/windows-runner-refcount"
const target = path.resolve(process.env.CARGO_TARGET_DIR || path.join(workspace, "target"))
const env = { ...process.env, CARGO_TARGET_DIR: target }
delete env.NODE_OPTIONS
delete env.CODENOMAD_NATIVE_PARENT
const binary = path.join(target, "release/codenomad-windows-runner-fixture.exe")

function cargo(args, cwd = workspace) {
  const result = spawnSync("cargo", args, { cwd, env, encoding: "utf8", timeout: 600_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}
function run(fixed, count) {
  let crashes = 0
  for (let index = 0; index < count; index++) {
    const result = spawnSync(binary, [], { env, encoding: "utf8", timeout: 35_000, windowsHide: true })
    assert.equal(result.error, undefined, String(result.error))
    assert.match(result.stdout, /START: concurrent Tauri runtime handle cloning/)
    if (fixed) {
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /PASS: 800000 runtime handle clones and clean teardown/)
    } else if (result.status !== 0) {
      // Native heap/access failures and Rust's abort on an invalid Rc refcount.
      assert.ok([0xc000001d, 0xc0000005, 0xc0000374, 0xc0000409].includes(result.status >>> 0),
        `Expected the native refcount failure, got ${result.status}: ${result.stdout}${result.stderr}`)
      crashes++
    } else {
      // A refcount race can leak rather than free early. One surviving process
      // is not a clean baseline; the series looks for a crash below.
      assert.match(result.stdout, /PASS: 800000 runtime handle clones and clean teardown/)
    }
    console.log(`${fixed ? "fixed PASS" : result.status === 0 ? "negative control survived" : "negative control crash reproduced"} ${index + 1}/${count}: 0x${(result.status >>> 0).toString(16)} (${machine})`)
    // One crash proves the reverted counter races on this machine.
    if (!fixed && crashes) return
  }
  if (fixed) return
  // The race is timing-dependent: some GitHub runners never hit it, so CI only
  // warns. The counter-boundary and vendored-Tao checks still guard the fix, but
  // corrected runs on such a machine are no timing evidence. Locally it fails.
  const message = `Negative control did not reproduce the native race in ${count} processes (${machine})`
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning::${message}; corrected runs here are no timing evidence`)
  else assert.fail(message)
}
const machine = `${os.cpus()[0]?.model.trim() ?? "unknown CPU"}, ${os.availableParallelism()} threads`
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one counter boundary: ${before}`)
  return source.replace(before, after)
}

if (process.argv.includes("--baseline")) {
  const temporaryRoot = path.join(os.tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  const baseline = await mkdtemp(path.join(temporaryRoot, "tauri-runner-baseline-"))
  try {
    await cp(path.join(workspace, fixture), path.join(baseline, fixture), { recursive: true })
    await cp(path.join(workspace, "vendor/tao-0.34.6"), path.join(baseline, "tao"), { recursive: true })
    await cp(path.join(workspace, "Cargo.lock"), path.join(baseline, "Cargo.lock"))
    const manifest = "src-tauri/examples/window_constraints_windows.manifest"
    await mkdir(path.dirname(path.join(baseline, manifest)), { recursive: true })
    await cp(path.join(workspace, manifest), path.join(baseline, manifest))
    await writeFile(path.join(baseline, "Cargo.toml"), `[workspace]\nmembers = ["${fixture}"]\nresolver = "2"\n[patch.crates-io]\ntao = { path = "tao" }\n`)
    // Reverse only this correction in a temporary copy. Existing input and macOS
    // backports, dependencies and the public Wry API exercised remain identical.
    const runner = path.join(baseline, "tao/src/platform_impl/windows/event_loop/runner.rs")
    let source = await readFile(runner, "utf8")
    source = replaceOnce(source, "  sync::Arc,", "  rc::Rc,")
    source = replaceOnce(source, "= Arc<EventLoopRunner<T>>;", "= Rc<EventLoopRunner<T>>;")
    await writeFile(runner, source)
    const loopFile = path.join(baseline, "tao/src/platform_impl/windows/event_loop.rs")
    await writeFile(loopFile, replaceOnce(await readFile(loopFile, "utf8"),
      "let runner_shared = Arc::new(", "let runner_shared = std::rc::Rc::new("))
    cargo(["build", "--release", "-p", "codenomad-windows-runner-fixture"], baseline)
    run(false, 50)
  } finally { await rm(baseline, { recursive: true, force: true }) }
}

const metadata = JSON.parse(cargo(["metadata", "--locked", "--format-version", "1"]))
const tao = metadata.packages.filter(item => item.name === "tao")
assert.equal(tao.length, 1)
assert.equal(path.resolve(tao[0].manifest_path), path.join(workspace, "vendor/tao-0.34.6/Cargo.toml"))
cargo(["build", "--locked", "--release", "-p", "codenomad-windows-runner-fixture"])
run(true, 5)
