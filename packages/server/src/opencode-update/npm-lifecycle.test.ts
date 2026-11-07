import assert from "node:assert/strict"
import test from "node:test"
import { execFile, execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { bundledNpm, executeNpm } from "./npm-runtime"

// The development Electron executable runs npm as packaged Electron does.
let electron: string | undefined
let unavailable = ""
try { electron = createRequire(import.meta.url)("electron") as string }
catch (error) { unavailable = `Electron binary unavailable: ${error instanceof Error ? error.message : String(error)}` }
const npm = bundledNpm(process.execPath, "")
if (!unavailable && !npm) unavailable = "npm is unavailable beside the test Node runtime"

test("Electron runs a real npm lifecycle `node` script through the prefix-scoped command", { skip: unavailable || false }, async () => {
  // Spaces exercise the Windows node.cmd quoting and the POSIX adapter path.
  const root = await mkdtemp(path.join(os.tmpdir(), "npm lifecycle "))
  try {
    const prefix = path.join(root, "npm prefix")
    const stage = path.join(root, "stage")
    const output = path.join(root, "lifecycle.json")
    await mkdir(prefix)
    await mkdir(path.join(stage, "package"), { recursive: true })
    await writeFile(path.join(stage, "package", "package.json"), JSON.stringify({
      name: "codenomad-lifecycle-fixture", version: "1.0.0", scripts: { postinstall: "node ./postinstall.js" },
    }))
    await writeFile(path.join(stage, "package", "postinstall.js"), "require('fs').writeFileSync(process.env.CODENOMAD_LIFECYCLE_OUTPUT, "
      + "JSON.stringify({ electron: process.versions.electron ?? null, execPath: process.execPath, execArgv: process.execArgv }))\n")
    // Relative names keep Windows tar from reading a drive letter as a host.
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"
    execFileSync(tar, ["-czf", "fixture.tgz", "package"], { cwd: stage, windowsHide: true })

    // No system Node on PATH: only the OS shell npm uses for lifecycle scripts.
    const tools = path.join(root, "tools")
    await mkdir(tools)
    if (process.platform !== "win32") await symlink("/bin/sh", path.join(tools, "sh"))
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PATH|npm_|NODE_)/i.test(key)))
    Object.assign(env, {
      PATH: process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : tools,
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ASAR: "1",
      CODENOMAD_LIFECYCLE_OUTPUT: output,
      npm_config_cache: path.join(root, "npm-cache"),
      npm_config_userconfig: path.join(root, "npmrc"),
      npm_config_update_notifier: "false",
    })

    // As for OpenCode, the installed package's own script is allowed explicitly
    // (npm 12+ blocks it otherwise); a local tarball is identified by its path.
    const tarball = path.join(stage, "fixture.tgz")
    await executeNpm(electron!, [npm!, "install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund",
      `--allow-scripts=${tarball}`, tarball], env, process.platform, prefix)

    const result = JSON.parse(await readFile(output, "utf8")) as { electron: string | null; execPath: string; execArgv: string[] }
    assert.match(result.electron ?? "", /^\d+\.\d+\.\d+/, "the lifecycle script ran under Electron")
    const same = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
    assert.ok(same(await realpath(result.execPath), await realpath(electron!)))
    // Windows: the lifecycle `node` command loads the console-hiding preload from
    // the prefix's installer directory; POSIX runs the script without it.
    if (process.platform === "win32") {
      assert.equal(result.execArgv.length, 2, JSON.stringify(result.execArgv))
      assert.equal(result.execArgv[0], "--require")
      const preload = result.execArgv[1]!
      assert.equal(path.basename(preload), "hide-child-windows.cjs")
      assert.equal(path.dirname(path.dirname(preload)), prefix)
      assert.match(path.basename(path.dirname(preload)), /^\.codenomad-npm-/)
    } else assert.deepEqual(result.execArgv, [])
    assert.deepEqual((await readdir(prefix)).filter(name => name.startsWith(".codenomad-")), [], "the adapter directory is removed")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("both runtimes support nested npm/npx commands and approved project lifecycles without system Node or npm", { skip: unavailable || false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "npm commands "))
  const { startFakeNpmRegistry } = await import(new URL("../../../../scripts/fixtures/fake-npm-registry.mjs", import.meta.url).href)
  const registry = await startFakeNpmRegistry()
  try {
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"
    const record = "const fs=require('fs'),path=require('path');fs.appendFileSync(process.env.CODENOMAD_COMMAND_OUTPUT,"
      + "JSON.stringify({execPath:process.execPath,npm:process.env.npm_execpath,node:process.version})+'\\n')\n"
    const archives: Record<string, string> = {}
    for (const name of ["allowed", "denied", "bin"]) {
      const stage = path.join(root, name)
      await mkdir(path.join(stage, "package"), { recursive: true })
      const manifest = { name: `codenomad-${name}`, version: "1.0.0", ...(name === "bin"
        ? { bin: { "codenomad-bin": "identity.cjs" } }
        : { scripts: name === "allowed" ? { postinstall: "npm run nested && npx --offline codenomad-bin lifecycle", nested: "node identity.cjs" }
          : { postinstall: "node -e \"require('fs').writeFileSync(process.env.CODENOMAD_DENIED_OUTPUT,JSON.stringify({command:process.env.npm_command,npm:process.env.npm_execpath}))\"" } }) }
      await writeFile(path.join(stage, "package/package.json"), JSON.stringify(manifest))
      await writeFile(path.join(stage, "package/identity.cjs"), "#!/usr/bin/env node\n" + record)
      execFileSync(tar, ["-czf", "fixture.tgz", "package"], { cwd: stage, windowsHide: true })
      registry.publish(`codenomad-${name}`, "1.0.0", await readFile(path.join(stage, "fixture.tgz")), manifest)
      archives[`codenomad-${name}`] = "1.0.0"
    }
    for (const [index, node] of [process.execPath, electron!].entries()) {
      const prefix = path.join(root, String(index))
      const project = path.join(prefix, "project")
      await mkdir(project, { recursive: true })
      await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "codenomad-project", version: "1.0.0", private: true,
        dependencies: archives, allowScripts: { "codenomad-denied": false },
        scripts: { build: "npm run nested && npx --offline codenomad-bin build", nested: "node identity.cjs" } }))
      await writeFile(path.join(project, "identity.cjs"), record)
      const output = path.join(prefix, "commands.jsonl")
      const denied = path.join(prefix, "denied")
      const tools = path.join(prefix, "tools")
      await mkdir(tools)
      if (process.platform !== "win32") await symlink("/bin/sh", path.join(tools, "sh"))
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PATH|npm_|NODE_)/i.test(key)))
      Object.assign(env, { PATH: process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : tools,
        HOME: prefix, USERPROFILE: prefix, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1",
        npm_config_cache: path.join(prefix, "cache"), npm_config_userconfig: path.join(prefix, "npmrc"),
        npm_config_globalconfig: path.join(prefix, "global-npmrc"), npm_config_audit: "false", npm_config_fund: "false",
        npm_config_registry: registry.url,
        npm_config_update_notifier: "false", CODENOMAD_COMMAND_OUTPUT: output, CODENOMAD_DENIED_OUTPUT: denied })
      const original = { ...env }
      const run = (args: string[]) => executeNpm(node, [npm!, "--prefix", project, ...args], env, process.platform, prefix,
        (file, commandArgs, childEnv, options) => new Promise<void>((resolve, reject) => {
          execFile(file, commandArgs, { env: childEnv, cwd: options?.cwd, windowsHide: true, timeout: 60_000 }, (error, _stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message))
            else resolve()
          })
        }))
      await run(["install", "--ignore-scripts"])
      // These are reviewed fixture packages: use npm's own approval/denial commands and policy format.
      await run(["install-scripts", "approve", "codenomad-allowed"])
      await run(["install-scripts", "deny", "codenomad-denied"])
      const policy = JSON.parse(await readFile(path.join(project, "package.json"), "utf8")).allowScripts
      assert.ok(Object.values(policy).includes(true))
      assert.equal(policy["codenomad-allowed@1.0.0"], true)
      assert.equal(policy["codenomad-denied"], false)
      await run(["rebuild", "--offline"])
      await run(["ci", "--offline"])
      await run(["run", "build"])
      const records = (await readFile(output, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { execPath: string; npm: string })
      assert.equal(records.length, 6, "rebuild, ci and build each run nested node and the npx dependency bin")
      const canonical = async (file: string) => {
        const resolved = await realpath(file)
        return process.platform === "win32" ? resolved.toLowerCase() : resolved
      }
      for (const entry of records) {
        assert.equal(await canonical(entry.execPath), await canonical(node))
        assert.equal(await canonical(path.dirname(entry.npm)), await canonical(path.dirname(npm!)))
      }
      assert.equal(await readFile(denied, "utf8").catch(() => undefined), undefined, "an explicitly denied lifecycle never runs")
      assert.deepEqual(JSON.parse(await readFile(path.join(project, "package.json"), "utf8")).allowScripts, policy)
      assert.deepEqual(env, original)
      assert.deepEqual((await readdir(prefix)).filter(name => name.startsWith(".codenomad-")), [])
    }
  } finally { await registry.close(); await rm(root, { recursive: true, force: true }) }
})
