// Builds the Rust server (packages/server-rs) for a desktop target and stages it in server/dist,
// beside the Node entry, where Tauri looks for it under CODENOMAD_SERVER_IMPL=rust.
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const rustTriples = {
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
}

function rustServerFile(target) {
  return target.startsWith("win32-") ? "codenomad-rs.exe" : "codenomad-rs"
}

/** Debug info the release backtrace reads beside the binary: Linux keeps it inside the binary. */
function rustServerSymbols(target) {
  if (target.startsWith("win32-")) return "codenomad_rs.pdb"
  if (target.startsWith("darwin-")) return "codenomad-rs.dSYM"
  return undefined
}

function stageRustServer({ workspaceRoot, serverDest, target, log = () => {}, env = process.env }) {
  const triple = rustTriples[target]
  if (!triple) throw new Error(`Unsupported Rust server target: ${target}`)
  const crate = path.join(workspaceRoot, "packages", "server-rs")
  const { version } = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "packages", "server", "package.json"), "utf8"))
  log(`building the Rust server for ${triple}`)
  const result = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", path.join(crate, "Cargo.toml"), "--target", triple], {
    stdio: "inherit",
    windowsHide: true,
    // macOS otherwise leaves the line tables in the build's object files.
    env: { ...env, CNRS_BUILD_VERSION: env.CNRS_BUILD_VERSION || version, ...(target.startsWith("darwin-") ? { CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO: "packed" } : {}) },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`cargo build of the Rust server exited with code ${result.status}`)
  const file = rustServerFile(target)
  const built = path.join(env.CARGO_TARGET_DIR ? path.resolve(env.CARGO_TARGET_DIR) : path.join(crate, "target"), triple, "release")
  const dest = path.join(serverDest, "dist", file)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(path.join(built, file), dest)
  fs.chmodSync(dest, 0o755)
  const symbols = rustServerSymbols(target)
  if (symbols) fs.cpSync(path.join(built, symbols), path.join(serverDest, "dist", symbols), { recursive: true })
  log(`staged the Rust server at ${dest}`)
  return dest
}

module.exports = { rustServerFile, rustServerSymbols, stageRustServer }
