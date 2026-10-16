import assert from "node:assert/strict"
import test from "node:test"
import { existsSync } from "node:fs"
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installSharedOpenCode, LegacyReplacementError, npmCommandDirectory, npmExecutable, resolveDefaultInstallation,
  sharedInstallationPlan, userNpmPrefix, type InstallationHost } from "./shared-installation"
import { legacyNpmInstallation, legacyNpmPackageRoot } from "./legacy-installation"
import { BinaryResolver } from "../settings/binaries"
import type { SettingsService } from "../settings/service"

const windows = process.platform === "win32"

// npm's cmd-shim output for a native executable bin.
const cmdShim = (target: string) => ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
  `"%dp0%\\${target.replaceAll("/", "\\")}"   %*`, ""].join("\r\n")

async function shim(prefix: string, name: string, target: string) {
  const directory = npmCommandDirectory(prefix)
  await mkdir(directory, { recursive: true })
  if (windows) {
    await writeFile(path.join(directory, `${name}.cmd`), cmdShim(target))
    await writeFile(path.join(directory, name), `#!/bin/sh\nexec "$basedir/${target}" "$@"\n`)
    await writeFile(path.join(directory, `${name}.ps1`), `& "$basedir/${target}" $args\n`)
    return path.join(directory, `${name}.cmd`)
  }
  const command = path.join(directory, name)
  await symlink(path.join("..", "lib", target), command)
  return command
}

/** OpenCode 1.x as published on npm: `opencode-ai` with an `opencode` native bin. */
async function legacyFixture(prefix: string, version = "1.18.10") {
  const root = legacyNpmPackageRoot(prefix, process.platform)
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(path.join(root, "bin", "opencode.exe"), version, { mode: 0o755 })
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "opencode-ai", version, bin: { opencode: "bin/opencode.exe" } }))
  return shim(prefix, "opencode", "node_modules/opencode-ai/bin/opencode.exe")
}

/** OpenCode 2 as published on npm: `@opencode/cli` with `opencode` and `opencode2` bins. */
async function cliFixture(prefix: string, version: string) {
  const binary = npmExecutable(prefix)
  await mkdir(path.dirname(binary), { recursive: true })
  await writeFile(binary, version, { mode: 0o755 })
  await writeFile(path.join(path.dirname(binary), "..", "package.json"), JSON.stringify({ name: "@opencode/cli", version,
    bin: { opencode: "./bin/opencode.exe", opencode2: "./bin/opencode.exe" } }))
  for (const name of ["opencode", "opencode2"]) await shim(prefix, name, "node_modules/@opencode/cli/bin/opencode.exe")
}

async function removeShims(prefix: string, name: string) {
  for (const suffix of windows ? ["", ".cmd", ".ps1"] : [""]) await rm(path.join(npmCommandDirectory(prefix), `${name}${suffix}`), { force: true })
}

function installer(prefix: string, calls: string[], fail?: () => Error | undefined) {
  return async (_node: string, args: string[]) => {
    assert.ok(existsSync(path.join(prefix, ".codenomad-opencode-install.lock")), "npm runs under the installation lock")
    assert.equal(args[args.indexOf("--prefix") + 1], prefix)
    const operation = args[1]!, target = args.at(-1)!
    calls.push(`${operation} ${target}`)
    if (operation === "uninstall") {
      await rm(legacyNpmPackageRoot(prefix, process.platform), { recursive: true, force: true })
      await removeShims(prefix, "opencode")
      return
    }
    const error = fail?.()
    if (error) throw error
    // npm refuses to link a bin over another package's shim without --force.
    if (existsSync(legacyNpmPackageRoot(prefix, process.platform))) throw new Error("EEXIST: file already exists")
    await cliFixture(prefix, target.split("@").at(-1)!)
  }
}

const probe = async (binary: string) => {
  try { return { valid: true, version: await readFile(binary, "utf8") } } catch { return { valid: false, missing: true } }
}

async function environment(name: string) {
  const home = await mkdtemp(path.join(os.tmpdir(), name))
  const env: NodeJS.ProcessEnv = { PATH: "", APPDATA: path.join(home, "Roaming"), LOCALAPPDATA: path.join(home, "Local"),
    ProgramFiles: path.join(home, "Program Files"), NPM_CONFIG_PREFIX: windows ? undefined : path.join(home, ".local") }
  const host: InstallationHost = { home, env }
  return { home, env, host, prefix: userNpmPrefix(host) }
}

/** winget portable layout: Links\opencode.exe (symlink, or hardlink fallback) to Packages\<id>_<source>\opencode.exe. */
async function wingetFixture(local: string, form: "symlink" | "hardlink") {
  const packageDirectory = path.join(local, "Microsoft", "WinGet", "Packages", "SST.opencode_Microsoft.Winget.Source_8wekyb3d8bbwe")
  const links = path.join(local, "Microsoft", "WinGet", "Links")
  await mkdir(packageDirectory, { recursive: true })
  await mkdir(links, { recursive: true })
  const target = path.join(packageDirectory, "opencode.exe")
  await writeFile(target, "1.19.0")
  const command = path.join(links, "opencode.exe")
  if (form === "symlink") await symlink(target, command, "file")
  else await link(target, command)
  return { command, links, target }
}

test("OpenCode 1.x npm shims are identified by package manifest and shim target only", async () => {
  const { home, prefix } = await environment("legacy-identity-")
  try {
    const command = await legacyFixture(prefix)
    const directory = npmCommandDirectory(prefix)
    assert.deepEqual(legacyNpmInstallation(command, prefix, directory, process.platform),
      { command, prefix, binary: path.join(legacyNpmPackageRoot(prefix, process.platform), "bin", "opencode.exe"), version: "1.18.10" })
    const manifest = path.join(legacyNpmPackageRoot(prefix, process.platform), "package.json")
    await writeFile(manifest, JSON.stringify({ name: "opencode-ai", version: "2.0.30", bin: { opencode: "bin/opencode.exe" } }))
    assert.equal(legacyNpmInstallation(command, prefix, directory, process.platform), undefined, "a supported version is never replaced")
    await writeFile(manifest, JSON.stringify({ name: "other", version: "1.18.10", bin: { opencode: "bin/opencode.exe" } }))
    assert.equal(legacyNpmInstallation(command, prefix, directory, process.platform), undefined)
    await legacyFixture(prefix)
    const wrapper = path.join(home, "wrapper.exe")
    await writeFile(wrapper, "custom")
    await rm(command)
    if (windows) await writeFile(command, `@echo off\r\n"${wrapper}" %*\r\n`)
    else await symlink(wrapper, command)
    assert.equal(legacyNpmInstallation(command, prefix, directory, process.platform), undefined, "custom wrappers are not npm shims")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("legacy npm OpenCode is replaced in its prefix only after explicit consent, under the lock", async () => {
  const { home, env, host, prefix } = await environment("legacy-replace-")
  try {
    const command = await legacyFixture(prefix)
    env.PATH = npmCommandDirectory(prefix)
    assert.deepEqual(resolveDefaultInstallation(host), { path: command, source: "path" })
    const plan = sharedInstallationPlan(host)
    assert.equal(plan.prefix, prefix)
    assert.equal(plan.legacy?.version, "1.18.10")
    assert.equal(plan.foreign, undefined)

    const calls: string[] = []
    let registered = 0
    const options = { ...host, node: process.execPath, npm: "fixture-npm.js", execute: installer(prefix, calls), probe,
      registerPath: async () => { registered++ } }
    await assert.rejects(installSharedOpenCode("2.0.30", options),
      (error: unknown) => error instanceof LegacyReplacementError && error.code === "legacy_replacement_required")
    assert.deepEqual(calls, [])
    assert.ok(existsSync(command), "nothing changes without consent")

    assert.equal(await installSharedOpenCode("2.0.30", { ...options, replaceLegacy: true }), npmExecutable(prefix))
    assert.deepEqual(calls, ["uninstall opencode-ai", "install @opencode/cli@2.0.30"])
    assert.equal(registered, 1)
    assert.equal(existsSync(path.join(prefix, ".codenomad-opencode-install.lock")), false)
    assert.equal(resolveDefaultInstallation(host).source, "path")
    assert.deepEqual(sharedInstallationPlan(host), { prefix })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("an OpenCode 2 installation failure after removing 1.x is reported and remains retryable", async () => {
  const { home, env, host, prefix } = await environment("legacy-failure-")
  try {
    await legacyFixture(prefix)
    env.PATH = npmCommandDirectory(prefix)
    const calls: string[] = []
    let offline = true
    const options = { ...host, node: process.execPath, npm: "fixture-npm.js", probe, registerPath: async () => {},
      execute: installer(prefix, calls, () => offline ? new Error("ENOTFOUND registry.npmjs.org") : undefined) }
    await assert.rejects(installSharedOpenCode("2.0.30", { ...options, replaceLegacy: true }), (error: unknown) =>
      error instanceof LegacyReplacementError && error.code === "legacy_removed_install_failed" && /ENOTFOUND/.test(error.message))
    assert.deepEqual(calls, ["uninstall opencode-ai", "install @opencode/cli@2.0.30"], "never retried through another mechanism")
    assert.equal(existsSync(path.join(prefix, ".codenomad-opencode-install.lock")), false)
    assert.deepEqual(sharedInstallationPlan(host), { prefix }, "retry is an ordinary installation without the removed package")
    offline = false
    await installSharedOpenCode("2.0.30", options)
    assert.deepEqual(calls.slice(2), ["install @opencode/cli@2.0.30"])
  } finally { await rm(home, { recursive: true, force: true }) }
})

for (const form of ["symlink", "hardlink"] as const) test(`winget OpenCode 1.x (${form}) stays untouched; OpenCode 2 installs beside it and is preferred`, async (t) => {
  if (!windows) return t.skip("winget layouts are Windows-only")
  const { home, env, host, prefix } = await environment(`winget-${form}-`)
  try {
    let winget
    try { winget = await wingetFixture(env.LOCALAPPDATA!, form) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks need Developer Mode"); throw error }
    env.PATH = [winget.links, npmCommandDirectory(prefix)].join(";")
    const probes: string[] = []
    const probeForeign = (command: string) => { probes.push(command); return { valid: true, version: "1.19.0" } }
    const wingetHost = { ...host, probeForeign }
    assert.deepEqual(resolveDefaultInstallation(wingetHost), { path: winget.command, source: "path" })
    assert.deepEqual(sharedInstallationPlan(wingetHost), { prefix, foreign: { command: winget.command, version: "1.19.0", source: "winget",
      ...(form === "symlink" ? { packageId: "SST.opencode" } : {}) } })

    const calls: string[] = []
    await installSharedOpenCode("2.0.30", { ...wingetHost, node: process.execPath, npm: "fixture-npm.js", probe,
      execute: installer(prefix, calls), registerPath: async () => {} })
    assert.deepEqual(calls, ["install @opencode/cli@2.0.30"])
    assert.deepEqual(resolveDefaultInstallation(wingetHost), { path: npmExecutable(prefix), source: "managed" })
    assert.equal(sharedInstallationPlan(wingetHost).prefix, prefix, "the managed installation keeps receiving updates")
    assert.equal(await readFile(winget.target, "utf8"), "1.19.0")
    assert.ok(existsSync(winget.command))
    assert.ok(probes.every(command => command === winget.command))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("winget OpenCode first on PATH with npm OpenCode 1.x behind it replaces only the npm package", async (t) => {
  if (!windows) return t.skip("winget layouts are Windows-only")
  const { home, env, host, prefix } = await environment("winget-npm-")
  try {
    const winget = await wingetFixture(env.LOCALAPPDATA!, "hardlink")
    await legacyFixture(prefix)
    env.PATH = [winget.links, npmCommandDirectory(prefix)].join(";")
    const wingetHost = { ...host, probeForeign: () => ({ valid: true, version: "1.19.0" }) }
    const plan = sharedInstallationPlan(wingetHost)
    assert.equal(plan.prefix, prefix)
    assert.equal(plan.legacy?.version, "1.18.10")
    assert.equal(plan.foreign?.source, "winget")
    const calls: string[] = []
    const options = { ...wingetHost, node: process.execPath, npm: "fixture-npm.js", probe, execute: installer(prefix, calls), registerPath: async () => {} }
    await assert.rejects(installSharedOpenCode("2.0.30", options), /explicit confirmation/)
    await installSharedOpenCode("2.0.30", { ...options, replaceLegacy: true })
    assert.deepEqual(calls, ["uninstall opencode-ai", "install @opencode/cli@2.0.30"])
    assert.deepEqual(resolveDefaultInstallation(wingetHost), { path: npmExecutable(prefix), source: "managed" })
    assert.equal(await readFile(winget.target, "utf8"), "1.19.0")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("valid foreign OpenCode 2 keeps PATH precedence; unusable foreign commands yield to managed OpenCode 2", async () => {
  const { home, env, host, prefix } = await environment("foreign-")
  try {
    await cliFixture(prefix, "2.0.30")
    const foreign = path.join(home, "tools", windows ? "opencode.exe" : "opencode")
    await mkdir(path.dirname(foreign), { recursive: true })
    await writeFile(foreign, "foreign", { mode: 0o755 })
    env.PATH = [path.dirname(foreign), npmCommandDirectory(prefix)].join(path.delimiter)
    for (const version of ["2.0.31", "local-build"]) {
      const probeForeign = () => ({ valid: true, version })
      assert.deepEqual(resolveDefaultInstallation({ ...host, probeForeign }), { path: foreign, source: "path" })
      assert.deepEqual(sharedInstallationPlan({ ...host, probeForeign }), {})
    }
    for (const probeForeign of [() => ({ valid: false }), () => ({ valid: true, version: "0.0.0-beta-19271" }), () => ({ valid: true, version: "1.18.10" })]) {
      assert.deepEqual(resolveDefaultInstallation({ ...host, probeForeign }), { path: npmExecutable(prefix), source: "managed" })
      assert.equal(sharedInstallationPlan({ ...host, probeForeign }).foreign?.source, "other")
    }
    assert.equal(await readFile(foreign, "utf8"), "foreign")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("an explicit custom executable is never replaced by the managed installation", () => {
  const settings = (opencodeBinary?: string) => ({
    getOwner: (kind: string) => kind === "config" ? { opencodeBinary } : {},
  }) as unknown as SettingsService
  const managed = () => ({ path: "/managed/opencode.exe", source: "managed" as const })
  assert.deepEqual(new BinaryResolver(settings(), managed).resolveDefault(), { path: "/managed/opencode.exe", label: "opencode.exe", version: undefined, source: "managed" })
  assert.equal(new BinaryResolver(settings("/custom/opencode"), managed).resolveDefault().path, "/custom/opencode")
  assert.equal(new BinaryResolver(settings("/custom/opencode"), managed).resolveDefault().source, undefined)
})
