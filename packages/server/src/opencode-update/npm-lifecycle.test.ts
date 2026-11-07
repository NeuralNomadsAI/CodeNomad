import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
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
