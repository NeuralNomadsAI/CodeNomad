import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { findPathOpenCode, installSharedOpenCode, npmCommandDirectory, npmExecutable, resolveDefaultInstallation, sharedInstallPrefix, userNpmPrefix } from "./shared-installation"
import { registerUserPath } from "./user-path"
import { withInstallationLock } from "./installation-lock"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

async function npmFixture(prefix: string, version: string) {
  const binary = npmExecutable(prefix)
  await mkdir(path.dirname(binary), { recursive: true })
  await writeFile(binary, version, { mode: 0o755 })
  await writeFile(path.join(path.dirname(binary), "..", "package.json"), JSON.stringify({ name: "@opencode/cli", bin: { opencode2: "./bin/opencode.exe" } }))
  const bin = npmCommandDirectory(prefix)
  await mkdir(bin, { recursive: true })
  const command = path.join(bin, process.platform === "win32" ? "opencode2.cmd" : "opencode2")
  if (process.platform === "win32") await writeFile(command, '@echo off\r\n"%~dp0\\node_modules\\@opencode\\cli\\bin\\opencode.exe" %*\r\n')
  else await symlink(binary, command).catch(error => { if (error.code !== "EEXIST") throw error })
  return command
}

test("PATH wins over newer private copies; existing user npm and private installations remain migration fallbacks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-opencode-"))
  const env = { PATH: "", APPDATA: path.join(home, "AppData") }
  const host = { home, env }
  try {
    const root = path.join(home, ".local/share/codenomad/opencode")
    const legacy = path.join(root, "2.0.99/node_modules/@opencode/cli/bin/opencode.exe")
    await mkdir(path.dirname(legacy), { recursive: true }); await writeFile(legacy, "legacy")
    await mkdir(path.join(root, "selected")); await writeFile(path.join(root, "selected/2.0.99"), "")
    assert.deepEqual(resolveDefaultInstallation(host), { path: legacy, source: "legacy" })
    const prefix = userNpmPrefix(host)
    await npmFixture(prefix, "2.0.11")
    assert.deepEqual(resolveDefaultInstallation(host), { path: npmExecutable(prefix), source: "user" })
    const existing = path.join(home, "existing npm")
    const command = await npmFixture(existing, "2.0.12")
    env.PATH = npmCommandDirectory(existing)
    assert.deepEqual(resolveDefaultInstallation(host), { path: command, source: "path" })
    assert.equal(sharedInstallPrefix(host), existing)
    assert.equal(await readFile(legacy, "utf8"), "legacy", "discovery never removes private installations")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("normal global-user npm install publishes terminal command and retries PATH registration without reinstalling", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-opencode-install-"))
  const env = { PATH: "", APPDATA: path.join(home, "AppData"), SHELL: "/bin/bash" }
  let installs = 0, registrations = 0
  const prefix = userNpmPrefix({ home, env })
  const options = { home, env, node: process.execPath, npm: "fixture-npm.js",
    execute: async (_file: string, args: string[]) => {
      installs++
      assert.ok(args.includes("--global"))
      assert.equal(args[args.indexOf("--prefix") + 1], prefix)
      await npmFixture(prefix, args.at(-1)!.split("@").at(-1)!)
    },
    probe: async (binary: string) => {
      try { return { valid: true, version: await readFile(binary, "utf8") } } catch { return { valid: false, missing: true } }
    },
    registerPath: async (directory: string) => {
      if (++registrations === 1) throw new Error("PATH write failed")
      await registerUserPath(directory, { home, env, registerWindowsPath: async () => {} })
    },
  }
  try {
    await assert.rejects(installSharedOpenCode("2.0.11", options), /PATH write failed/)
    assert.equal((await options.probe(npmExecutable(prefix))).version, "2.0.11", "installation survives PATH failure")
    assert.equal((resolveDefaultInstallation(options)).source, "user", "repair remains discoverable")
    assert.equal(await installSharedOpenCode("2.0.11", options), npmExecutable(prefix))
    assert.equal(installs, 1)
    assert.equal(resolveDefaultInstallation(options).path, findPathOpenCode(options))
    assert.equal(resolveDefaultInstallation(options).source, "path")
    await installSharedOpenCode("2.0.12", options)
    assert.equal(installs, 2)
    await installSharedOpenCode("2.0.11", options)
    assert.equal(installs, 2, "never downgrade a newer common installation")
    assert.equal((await options.probe(npmExecutable(prefix))).version, "2.0.12")
    await rm(findPathOpenCode(options)!)
    await installSharedOpenCode("2.0.11", options)
    assert.equal(installs, 3, "missing command is repaired at the newer installed version")
    assert.equal((await options.probe(npmExecutable(prefix))).version, "2.0.12")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("independent backends cannot replace a shared installation concurrently; failures release the lock", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-opencode-lock-"))
  try {
    await withInstallationLock(home, async () => {
      const module = new URL("./installation-lock.ts", import.meta.url).href
      const script = `import { withInstallationLock } from ${JSON.stringify(module)};
        try { await withInstallationLock(${JSON.stringify(home)}, async () => { throw new Error('entered'); }); process.exit(2); }
        catch (error) { if (error.code !== 'installation_busy') throw error; }`
      await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script])
    })
    await assert.rejects(withInstallationLock(home, async () => { throw new Error("fixture failure") }), /fixture failure/)
    assert.equal(await withInstallationLock(home, async () => "released"), "released")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("standalone opencode commands and custom npm prefixes are discovered without mutation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-opencode-prefix-"))
  try {
    const prefix = path.join(home, "custom npm")
    const host = { home, env: { PATH: "", NPM_CONFIG_PREFIX: prefix } }
    assert.equal(userNpmPrefix(host), prefix)
    await npmFixture(prefix, "2.0.12")
    assert.equal(resolveDefaultInstallation(host).path, npmExecutable(prefix))
    const command = path.join(home, process.platform === "win32" ? "opencode.exe" : "opencode")
    await writeFile(command, "standalone", { mode: 0o755 })
    host.env.PATH = home
    assert.equal(resolveDefaultInstallation(host).path, command)
    assert.equal(sharedInstallPrefix(host), undefined)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("historical npm launchers select the real executable and allow stable migration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-opencode-history-"))
  try {
    for (const [version, name, oldBinary] of [["0.0.0-beta-19275", "opencode2", "opencode2.exe"], ["2.0.0", "opencode", "opencode.exe"]]) {
      const prefix = path.join(home, version)
      const binary = path.join(path.dirname(npmExecutable(prefix)), oldBinary)
      await mkdir(path.dirname(binary), { recursive: true })
      await writeFile(binary, version, { mode: 0o755 })
      await writeFile(path.join(path.dirname(binary), "..", "package.json"), JSON.stringify({ name: "@opencode/cli", bin: {
        opencode2: name === "opencode2" ? `./bin/${oldBinary}` : "./bin/opencode2.cjs", opencode: "./bin/opencode.exe",
      } }))
      const directory = npmCommandDirectory(prefix)
      await mkdir(directory, { recursive: true })
      const command = path.join(directory, process.platform === "win32" ? `${name}.cmd` : name)
      if (process.platform === "win32") {
        await writeFile(command, `@echo off\r\n"%~dp0\\node_modules\\@opencode\\cli\\bin\\${oldBinary}" %*\r\n`)
        if (name === "opencode") await writeFile(path.join(directory, "opencode2.cmd"), "@echo off\r\nexit /b 1\r\n")
      } else {
        await symlink(binary, command)
        if (name === "opencode") {
          const retired = path.join(path.dirname(binary), "opencode2.cjs")
          await writeFile(retired, "retired", { mode: 0o755 })
          await symlink(retired, path.join(directory, "opencode2"))
        }
      }
      const host = { home, env: { PATH: directory, APPDATA: home } }
      assert.equal(resolveDefaultInstallation(host).path, command)
      assert.equal(sharedInstallPrefix(host), prefix)
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("PATH executable precedence wins over npm shims in the same prefix", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-opencode-precedence-"))
  try {
    const prefix = path.join(home, "npm")
    const directory = npmCommandDirectory(prefix)
    await npmFixture(prefix, "2.0.3")
    const standalone = path.join(directory, process.platform === "win32" ? "opencode2.exe" : "opencode")
    if (process.platform === "win32") await writeFile(standalone, "standalone")
    else {
      await rm(standalone, { force: true })
      await writeFile(standalone, "standalone", { mode: 0o755 })
    }
    const host = { home, env: { PATH: directory } }
    if (process.platform === "win32") {
      assert.equal(resolveDefaultInstallation(host).path, standalone)
      assert.equal(sharedInstallPrefix(host), undefined)
    } else {
      const sibling = path.join(prefix, "sibling")
      await mkdir(sibling)
      const unrelated = path.join(sibling, "opencode2")
      await writeFile(unrelated, "standalone", { mode: 0o755 })
      assert.equal(resolveDefaultInstallation({ home, env: { PATH: sibling } }).path, unrelated)
      assert.equal(sharedInstallPrefix({ home, env: { PATH: sibling } }), undefined)
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("non-npm PATH executables are reused without allowing npm to shadow them", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-opencode-custom-"))
  try {
    const binary = path.join(home, process.platform === "win32" ? "opencode2.exe" : "opencode2")
    await writeFile(binary, "custom", { mode: 0o755 })
    const options = { home, env: { PATH: home }, npm: "fixture-npm.js" }
    assert.equal(resolveDefaultInstallation(options).path, binary)
    assert.equal(sharedInstallPrefix(options), undefined)
    await assert.rejects(installSharedOpenCode("2.0.11", options), /not a writable npm installation/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("shell PATH registration preserves profiles and is idempotent for bash, zsh, fish and Windows", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "opencode-shells-"))
  try {
    for (const shell of ["bash", "zsh", "fish"]) {
      const user = path.join(home, shell)
      const bin = `/users/example/${shell}/bin with spaces`
      await mkdir(user)
      const env = { PATH: "/existing", SHELL: `/bin/${shell}` }
      await writeFile(path.join(user, ".profile"), "# user settings\n")
      const options = { home: user, env, platform: "linux" as const }
      await registerUserPath(bin, options)
      const file = shell === "bash" ? ".bashrc" : shell === "zsh" ? ".zshrc" : ".config/fish/conf.d/opencode-path.fish"
      const first = await readFile(path.join(user, file), "utf8")
      await registerUserPath(bin, options)
      assert.equal(await readFile(path.join(user, file), "utf8"), first)
      assert.ok((await readFile(path.join(user, ".profile"), "utf8")).startsWith("# user settings\n"))
      assert.equal(env.PATH, `/existing:${bin}`)
    }
    const env = { Path: "C:\\existing" }
    let registered = ""
    await registerUserPath("C:\\user\\npm", { home, platform: "win32", env, registerWindowsPath: async bin => { registered = bin } })
    assert.equal(registered, "C:\\user\\npm")
    assert.equal(env.Path, "C:\\existing;C:\\user\\npm")
  } finally { await rm(home, { recursive: true, force: true }) }
})
