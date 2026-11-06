import assert from "node:assert/strict"
import test from "node:test"
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bundledNpm, executeNpm, npmNeedsNodeCommand } from "./npm-runtime"
import { InstallationInterruptedError } from "./installation-lock"

test("discovers Electron npm resources on each platform and preserves Node layouts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "npm-discovery-"))
  try {
    for (const target of ["win32-x64", "linux-x64", "darwin-arm64"]) {
      const resources = path.join(root, target === "darwin-arm64" ? "CodeNomad.app/Contents/Resources" : target + "/resources")
      const npm = path.join(resources, "node", target, "npm/bin/npm-cli.js")
      await mkdir(path.dirname(npm), { recursive: true })
      await writeFile(npm, "")
      assert.equal(bundledNpm(path.join(root, "CodeNomad"), resources, target), npm)
    }
    for (const relative of ["node_modules/npm/bin/npm-cli.js", "../lib/node_modules/npm/bin/npm-cli.js"]) {
      const directory = path.join(root, relative.startsWith("..") ? "posix/bin" : "windows")
      const npm = path.resolve(directory, relative)
      await mkdir(path.dirname(npm), { recursive: true })
      await writeFile(npm, "")
      assert.equal(bundledNpm(path.join(directory, "node"), "", "linux-x64"), npm)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("Electron lifecycle node command is scoped, cleaned, and retained on interruption", async () => {
  for (const platform of ["win32", "linux"] as const) for (const outcome of ["success", "failure", "interrupted"]) {
    const env = { ELECTRON_RUN_AS_NODE: "1", Path: "/original" }
    let directory = ""
    const pending = executeNpm("/application/CodeNomad", ["npm-cli.js"], env, platform, async (file, args, childEnv, options) => {
      assert.equal(file, "/application/CodeNomad")
      assert.deepEqual(args, ["npm-cli.js"])
      directory = options?.cwd ?? ""
      assert.ok(childEnv.Path!.startsWith(directory + (platform === "win32" ? ";" : ":")))
      assert.equal(childEnv.ELECTRON_RUN_AS_NODE, "1")
      assert.equal(childEnv.CODENOMAD_NPM_NODE, file)
      assert.match(await readFile(path.join(directory, platform === "win32" ? "node.cmd" : "node"), "utf8"), /CODENOMAD_NPM_NODE/)
      if (outcome === "interrupted") throw new InstallationInterruptedError()
      if (outcome === "failure") throw new Error("failed")
    })
    if (outcome === "success") await pending
    else await assert.rejects(pending)
    assert.deepEqual(env, { ELECTRON_RUN_AS_NODE: "1", Path: "/original" })
    if (outcome === "interrupted") {
      await access(directory)
      await rm(directory, { recursive: true, force: true })
    } else await assert.rejects(access(directory), { code: "ENOENT" })
  }
})

test("Tauri's Node runs npm with its own directory on PATH and no adapter, even with ELECTRON_RUN_AS_NODE", async () => {
  // A private temporary root proves that no adapter directory is created.
  const temporary = await mkdtemp(path.join(os.tmpdir(), "npm-tauri-"))
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
  Object.assign(process.env, { TMPDIR: temporary, TEMP: temporary, TMP: temporary })
  try {
    assert.equal(os.tmpdir(), temporary)
    for (const [platform, node, directory] of [["win32", "C:/CodeNomad/resources/node/node.exe", "C:/CodeNomad/resources/node"],
      ["win32", "C:/CodeNomad/resources/node/NODE.EXE", "C:/CodeNomad/resources/node"],
      ["linux", "/opt/CodeNomad/node/bin/node", "/opt/CodeNomad/node/bin"],
      ["darwin", "/Applications/CodeNomad.app/Contents/Resources/node/bin/node", "/Applications/CodeNomad.app/Contents/Resources/node/bin"]] as const) {
      assert.equal(npmNeedsNodeCommand(node, platform), false)
      const env = { ELECTRON_RUN_AS_NODE: "1", Path: "/original" }
      let called = false
      await executeNpm(node, ["npm-cli.js"], env, platform, async (file, args, childEnv, options) => {
        called = true
        assert.equal(file, node)
        assert.deepEqual(args, ["npm-cli.js"])
        assert.equal(options?.cwd, undefined)
        assert.equal(childEnv.Path, directory + (platform === "win32" ? ";" : ":") + "/original")
        assert.equal(childEnv.CODENOMAD_NPM_NODE, undefined)
      })
      assert.ok(called)
      assert.deepEqual(env, { ELECTRON_RUN_AS_NODE: "1", Path: "/original" })
    }
    assert.deepEqual(await readdir(temporary), [])
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(temporary, { recursive: true, force: true })
  }
  for (const [platform, node] of [["win32", "C:\\CodeNomad\\CodeNomad.exe"], ["linux", "/opt/CodeNomad/CodeNomad"],
    ["darwin", "/Applications/CodeNomad.app/Contents/MacOS/CodeNomad"], ["linux", "/usr/bin/node.exe"]] as const) {
    assert.equal(npmNeedsNodeCommand(node, platform), true)
  }
})
