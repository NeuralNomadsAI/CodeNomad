import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))
const manifest = readJson(path.join(root, "package.json"))
const workspaces = manifest.workspaces.packages
const directory = mkdtempSync(path.join(tmpdir(), "codenomad-release-version-"))

function npm(args) {
  const windows = process.platform === "win32"
  const result = spawnSync(windows ? "cmd.exe" : "npm", windows ? ["/d", "/s", "/c", "npm", ...args] : args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 60_000,
  })
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`)
}

try {
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    name: manifest.name, version: manifest.version, private: true, workspaces,
  }))
  for (const workspace of workspaces) {
    const source = readJson(path.join(root, workspace, "package.json"))
    const target = { name: source.name, version: source.version, private: true }
    // Keep the real internal dependency; external packages are irrelevant to local linking.
    if (workspace === "packages/server") {
      target.devDependencies = { "@codenomad/remote-tunnel": source.devDependencies["@codenomad/remote-tunnel"] }
    }
    mkdirSync(path.join(directory, workspace), { recursive: true })
    writeFileSync(path.join(directory, workspace, "package.json"), JSON.stringify(target))
  }

  for (const version of ["0.20.2", "0.20.2-dev-20261010-8ef07b04"]) {
    npm(["version", version, "--workspaces", "--include-workspace-root", "--no-git-tag-version", "--allow-same-version", "--offline"])
    const lock = readJson(path.join(directory, "package-lock.json"))
    for (const workspace of ["", ...workspaces]) {
      assert.equal(readJson(path.join(directory, workspace, "package.json")).version, version)
      assert.equal(lock.packages[workspace].version, version)
    }
    npm(["ci", "--workspaces", "--include=optional", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"])
    assert.equal(
      realpathSync(path.join(directory, "node_modules/@codenomad/remote-tunnel")),
      realpathSync(path.join(directory, "packages/remote-tunnel")),
    )
  }
  console.log("Stable and prerelease versioning + clean install retain the local remote-tunnel workspace, offline.")
} finally {
  rmSync(directory, { recursive: true, force: true })
}
