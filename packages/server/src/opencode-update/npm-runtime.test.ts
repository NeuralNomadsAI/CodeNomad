import assert from "node:assert/strict"
import test from "node:test"
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { bundledNpm, executeNpm, npmNeedsNodeCommand, writeNpmCommands } from "./npm-runtime"
import { InstallationInterruptedError, withInstallationLock } from "./installation-lock"

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

test("scoped npm/npx quote runtime, CLI paths and arguments without invoking caller commands", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "npm & $ commands ")))
  try {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key]
    env.PATH = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/bin"
    const runtime = path.join(root, process.platform === "win32" ? "runtime & $.exe" : "runtime & $")
    await copyFile(process.execPath, runtime)
    await chmod(runtime, 0o700)
    const npm = path.join(root, "npm-cli.js")
    for (const name of ["npm", "npx"]) await writeFile(path.join(root, name + "-cli.js"),
      "console.log(JSON.stringify({execPath:process.execPath,cli:__filename,args:process.argv.slice(2)}))")
    await writeNpmCommands(root, runtime, npm, env, process.platform)
    for (const name of ["npm", "npx"]) {
      const output = process.platform === "win32"
        ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `${name} "a & b"`],
          { env, cwd: root, windowsVerbatimArguments: true, windowsHide: true, encoding: "utf8" })
        : spawnSync(path.join(root, name), ["a & b"], { env, cwd: root, windowsHide: true, encoding: "utf8" })
      assert.equal(output.status, 0, output.stderr)
      const result = JSON.parse(output.stdout)
      assert.equal(result.execPath, runtime)
      assert.equal(result.cli, path.join(root, name + "-cli.js"))
      assert.deepEqual(result.args, ["a & b"])
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

/** Runs `body` with a private, initially empty system temporary directory and
 * a separate npm prefix, so a test can prove which of them the installer used. */
async function withPrivateTemporary(body: (temporary: string, prefix: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "npm-runtime-"))
  const temporary = path.join(root, "tmp")
  const prefix = path.join(root, "npm prefix")
  await mkdir(temporary)
  await mkdir(prefix)
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
  Object.assign(process.env, { TMPDIR: temporary, TEMP: temporary, TMP: temporary })
  try {
    assert.equal(os.tmpdir(), temporary)
    await body(temporary, prefix)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

test("the console-hiding preload makes every asynchronous child process hide its window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "npm-hide-windows-"))
  try {
    // The real writer's Windows preload; it loads under any OS's Node.
    const env: NodeJS.ProcessEnv = {}
    const [flag, preload] = await writeNpmCommands(root, "/application/CodeNomad", "npm-cli.js", env, "win32")
    assert.equal(flag, "--require")
    // Loaded first, the spy sits beneath the preload's patch and sees the final options.
    const spy = path.join(root, "spy.cjs")
    await writeFile(spy, "const fs = require('fs'); const { ChildProcess } = require('child_process')\n"
      + "const spawn = ChildProcess.prototype.spawn\n"
      + "ChildProcess.prototype.spawn = function (options) {\n"
      + "  fs.appendFileSync(process.env.CODENOMAD_SPY_OUTPUT, JSON.stringify({ file: options.file, windowsHide: options.windowsHide }) + '\\n')\n"
      + "  return spawn.call(this, options)\n}\n")
    const empty = path.join(root, "empty.cjs")
    await writeFile(empty, "")
    // Trivial children asking for a visible window (or not saying), through each async API.
    const script = `const cp = require("child_process"), node = process.execPath
const exited = child => new Promise(resolve => child.on("exit", resolve))
Promise.all([
  exited(cp.spawn(node, ["-e", ""], { windowsHide: false, stdio: "ignore" })),
  exited(cp.execFile(node, ["-e", ""], () => {})),
  exited(cp.exec(JSON.stringify(node) + ' -e ""', { windowsHide: false }, () => {})),
  exited(cp.fork(${JSON.stringify(empty)}, [], { windowsHide: false, execArgv: [], silent: true })),
]).then(() => process.exit(0))`
    const run = (preloads: string[]) => {
      const output = path.join(root, `spy-${preloads.length}.jsonl`)
      // This test's own child is hidden; with piped stdio it gets a console without a window.
      execFileSync(process.execPath, [...preloads.flatMap(file => ["--require", file]), "-e", script],
        { env: { ...process.env, CODENOMAD_SPY_OUTPUT: output }, windowsHide: true, stdio: "pipe", timeout: 60_000 })
      return readFile(output, "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line) as { windowsHide: boolean }))
    }
    // Control: without the preload the spy records the callers' own options.
    assert.deepEqual((await run([spy])).map(call => call.windowsHide), [false, false, false, false])
    const calls = await run([spy, preload!])
    assert.equal(calls.length, 4)
    assert.deepEqual(calls.map(call => call.windowsHide), [true, true, true, true])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("Electron lifecycle node command lives in the prefix, is cleaned, and is retained on interruption", async () => {
  await withPrivateTemporary(async (temporary, prefix) => {
    for (const platform of ["win32", "linux"] as const) for (const outcome of ["success", "failure", "interrupted"]) {
      const env = { ELECTRON_RUN_AS_NODE: "1", Path: "/original" }
      let directory = ""
      const pending = executeNpm("/application/CodeNomad", ["npm-cli.js"], env, platform, prefix, async (file, args, childEnv, options) => {
        assert.equal(file, "/application/CodeNomad")
        directory = options?.cwd ?? ""
        assert.equal(path.dirname(directory), prefix)
        assert.match(path.basename(directory), /^\.codenomad-npm-/)
        // Windows: npm and lifecycle `node` load the preload hiding their children's consoles.
        const preload = path.join(directory, "hide-child-windows.cjs")
        assert.deepEqual(args, platform === "win32" ? ["--require", preload, "npm-cli.js"] : ["npm-cli.js"])
        assert.equal(childEnv.CODENOMAD_NPM_PRELOAD, platform === "win32" ? preload : undefined)
        if (platform === "win32") assert.match(await readFile(preload, "utf8"), /windowsHide: true/)
        else await assert.rejects(access(preload), { code: "ENOENT" })
        assert.ok(childEnv.Path!.startsWith(directory + (platform === "win32" ? ";" : ":")))
        assert.equal(childEnv.ELECTRON_RUN_AS_NODE, "1")
        assert.equal(childEnv.CODENOMAD_NPM_NODE, file)
        assert.equal(await readFile(path.join(directory, platform === "win32" ? "node.cmd" : "node"), "utf8"), platform === "win32"
          ? '@echo off\r\n"%CODENOMAD_NPM_NODE%" --require "%CODENOMAD_NPM_PRELOAD%" %*\r\n'
          : '#!/bin/sh\nexec "$CODENOMAD_NPM_NODE" "$@"\n')
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
    assert.deepEqual(await readdir(prefix), [])
    assert.deepEqual(await readdir(temporary), [], "nothing executable is written to the system temporary directory")
  })
})

test("Tauri gets scoped npm/npx commands and keeps its Node on PATH without a node adapter", async () => {
  await withPrivateTemporary(async (temporary, prefix) => {
    for (const [platform, node, directory] of [["win32", "C:/CodeNomad/resources/node/node.exe", "C:/CodeNomad/resources/node"],
      ["win32", "C:/CodeNomad/resources/node/NODE.EXE", "C:/CodeNomad/resources/node"],
      ["linux", "/opt/CodeNomad/node/bin/node", "/opt/CodeNomad/node/bin"],
      ["darwin", "/Applications/CodeNomad.app/Contents/Resources/node/bin/node", "/Applications/CodeNomad.app/Contents/Resources/node/bin"]] as const) for (const outcome of ["success", "failure", "interrupted"]) {
      assert.equal(npmNeedsNodeCommand(node, platform), false)
      const env = { ELECTRON_RUN_AS_NODE: "1", Path: "/original" }
      let called = false
      let adapter = ""
      const pending = withInstallationLock(prefix, () => executeNpm(node, ["npm-cli.js"], env, platform, prefix, async (file, args, childEnv, options) => {
        called = true
        assert.equal(file, node)
        assert.deepEqual(args, ["npm-cli.js"])
        adapter = options!.cwd!
        assert.equal(path.dirname(adapter), prefix)
        assert.equal(childEnv.Path, [adapter, directory, "/original"].join(platform === "win32" ? ";" : ":"))
        assert.equal(childEnv.CODENOMAD_NPM_NODE, node)
        assert.equal(childEnv.CODENOMAD_NPM_CLI, "npm-cli.js")
        assert.equal(childEnv.CODENOMAD_NPX_CLI, "npx-cli.js")
        for (const name of ["npm", "npx"]) assert.match(await readFile(path.join(adapter, name + (platform === "win32" ? ".cmd" : "")), "utf8"), /CODENOMAD_NPM_NODE/)
        await assert.rejects(access(path.join(adapter, platform === "win32" ? "node.cmd" : "node")), { code: "ENOENT" })
        if (outcome === "interrupted") throw new InstallationInterruptedError()
        if (outcome === "failure") throw new Error("failed")
      }))
      if (outcome === "success") await pending
      else await assert.rejects(pending)
      const lock = path.join(prefix, ".codenomad-opencode-install.lock")
      if (outcome === "interrupted") {
        await access(adapter); await access(lock)
        await rm(adapter, { recursive: true, force: true }); await rm(lock)
      } else {
        await assert.rejects(access(adapter), { code: "ENOENT" })
        await assert.rejects(access(lock), { code: "ENOENT" })
      }
      assert.ok(called)
      assert.deepEqual(env, { ELECTRON_RUN_AS_NODE: "1", Path: "/original" })
    }
    assert.deepEqual(await readdir(temporary), [])
    assert.deepEqual(await readdir(prefix), [])
  })
  for (const [platform, node] of [["win32", "C:\\CodeNomad\\CodeNomad.exe"], ["linux", "/opt/CodeNomad/CodeNomad"],
    ["darwin", "/Applications/CodeNomad.app/Contents/MacOS/CodeNomad"], ["linux", "/usr/bin/node.exe"]] as const) {
    assert.equal(npmNeedsNodeCommand(node, platform), true)
  }
})
