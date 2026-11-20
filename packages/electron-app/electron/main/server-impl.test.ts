import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { resolveRustServer, rustServerFile, usesRustServer } from "./server-impl"

test("only CODENOMAD_SERVER_IMPL=rust selects the Rust server", () => {
  assert.equal(usesRustServer({}), false)
  assert.equal(usesRustServer({ CODENOMAD_SERVER_IMPL: "node" }), false)
  assert.equal(usesRustServer({ CODENOMAD_SERVER_IMPL: " Rust " }), true)
  assert.equal(rustServerFile("win32"), "codenomad-rs.exe")
  assert.equal(rustServerFile("linux"), "codenomad-rs")
})

test("the Rust server resolves from the packaged resources or the newest Cargo build", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rust-server-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = rustServerFile()
  const place = (...parts: string[]) => {
    const target = path.join(root, ...parts, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, "")
    return target
  }
  const location = { resourceRoots: [path.join(root, "missing"), path.join(root, "resources")], workspaceRoot: path.join(root, "repo"), env: {} }
  assert.equal(resolveRustServer({ ...location, dev: false }), undefined)

  const release = place("repo", "packages", "server-rs", "target", "release")
  const debug = place("repo", "packages", "server-rs", "target", "debug")
  utimesSync(release, new Date(), new Date(Date.now() - 60_000))
  assert.equal(resolveRustServer({ ...location, dev: true }), debug)
  const custom = place("cargo-target", "release")
  assert.equal(resolveRustServer({ ...location, dev: true, env: { CARGO_TARGET_DIR: path.join(root, "cargo-target") } }), custom)

  const packaged = place("resources", "server", "dist")
  assert.equal(resolveRustServer({ ...location, dev: false }), packaged)
  assert.equal(resolveRustServer({ ...location, dev: true }), debug)
})
