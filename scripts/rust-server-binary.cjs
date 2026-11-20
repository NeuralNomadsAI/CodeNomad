// Builds the Rust server (packages/server-rs) for a desktop target and stages it in server/dist,
// beside the Node entry, where the hosts look for it under CODENOMAD_SERVER_IMPL=rust.
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

function stageRustServer({ workspaceRoot, serverDest, target, log = () => {}, env = process.env }) {
  const triple = rustTriples[target]
  if (!triple) throw new Error(`Unsupported Rust server target: ${target}`)
  const crate = path.join(workspaceRoot, "packages", "server-rs")
  const { version } = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "packages", "server", "package.json"), "utf8"))
  log(`building the Rust server for ${triple}`)
  const result = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", path.join(crate, "Cargo.toml"), "--target", triple], {
    stdio: "inherit",
    windowsHide: true,
    env: { ...env, CNRS_BUILD_VERSION: env.CNRS_BUILD_VERSION || version },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`cargo build of the Rust server exited with code ${result.status}`)
  const file = rustServerFile(target)
  const built = path.join(env.CARGO_TARGET_DIR ? path.resolve(env.CARGO_TARGET_DIR) : path.join(crate, "target"), triple, "release", file)
  const dest = path.join(serverDest, "dist", file)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(built, dest)
  fs.chmodSync(dest, 0o755)
  log(`staged the Rust server at ${dest}`)
  return dest
}

module.exports = { rustServerFile, stageRustServer }
