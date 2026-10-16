import assert from "node:assert/strict"
import test from "node:test"
import { existsSync } from "node:fs"
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installSharedOpenCode, LegacyReplacementError, npmCommandDirectory, npmExecutable, resolveDefaultInstallation,
  sharedInstallationPlan, userNpmPrefix, type InstallationHost } from "./shared-installation"
import { legacyNativeImages, legacyNpmInstallation, legacyNpmPackageRoot } from "./legacy-installation"
import { cachedForeignProbe, probeForeignCommand } from "./foreign-probe"
import { InstallationBusyError } from "./installation-lock"
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

    for (const stale of [{ path: command, version: "1.18.9" }, { path: path.join(home, "other", "opencode.cmd"), version: "1.18.10" }]) {
      await assert.rejects(installSharedOpenCode("2.0.30", { ...options, replaceLegacy: stale }),
        (error: unknown) => error instanceof LegacyReplacementError && error.code === "legacy_replacement_required")
    }
    assert.deepEqual(calls, [], "consent applies only to the exact installation shown")

    assert.equal(await installSharedOpenCode("2.0.30", { ...options, replaceLegacy: { path: command, version: "1.18.10" } }), npmExecutable(prefix))
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
    const command = await legacyFixture(prefix)
    env.PATH = npmCommandDirectory(prefix)
    const calls: string[] = []
    let offline = true
    const options = { ...host, node: process.execPath, npm: "fixture-npm.js", probe, registerPath: async () => {},
      execute: installer(prefix, calls, () => offline ? new Error("ENOTFOUND registry.npmjs.org") : undefined) }
    await assert.rejects(installSharedOpenCode("2.0.30", { ...options, replaceLegacy: { path: command, version: "1.18.10" } }), (error: unknown) =>
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
    await installSharedOpenCode("2.0.30", { ...options, replaceLegacy: { path: plan.legacy!.command, version: "1.18.10" } })
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
    // Valid OpenCode 2, custom labels and unknown (not yet probed or timed out) keep PATH precedence.
    for (const probeForeign of [() => ({ valid: true, version: "2.0.31" }), () => ({ valid: true, version: "local-build" }), () => undefined]) {
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

/** opencode-ai 1.0-1.15.0: a Node launcher bin, a bin/.opencode copy and the
 * native executable in a nested platform package. */
async function launcherFixture(prefix: string, version = "1.15.0") {
  const root = legacyNpmPackageRoot(prefix, process.platform)
  const nested = path.join(root, "node_modules", "opencode-windows-x64", "bin", "opencode.exe")
  await mkdir(path.dirname(nested), { recursive: true })
  await writeFile(nested, version)
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(path.join(root, "bin", "opencode"), "#!/usr/bin/env node\n", { mode: 0o755 })
  await writeFile(path.join(root, "bin", ".opencode"), version)
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "opencode-ai", version, bin: { opencode: "bin/opencode" } }))
  const directory = npmCommandDirectory(prefix)
  await mkdir(directory, { recursive: true })
  if (!windows) {
    const command = path.join(directory, "opencode")
    await symlink(path.join("..", "lib", "node_modules", "opencode-ai", "bin", "opencode"), command)
    return { command, nested }
  }
  // npm's cmd-shim output for a Node script bin.
  const command = path.join(directory, "opencode.cmd")
  await writeFile(command, ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*', ""].join("\r\n"))
  return { command, nested }
}

test("opencode-ai 1.0-1.15.0 Node-launcher installs are recognized and every native image is preflighted", async (t) => {
  const { home, env, host, prefix } = await environment("legacy-launcher-")
  try {
    const { command, nested } = await launcherFixture(prefix)
    env.PATH = npmCommandDirectory(prefix)
    const plan = sharedInstallationPlan(host)
    assert.equal(plan.legacy?.command, command)
    assert.equal(plan.legacy?.version, "1.15.0")
    const root = legacyNpmPackageRoot(prefix, process.platform)
    assert.deepEqual(legacyNativeImages(root).sort(), [path.join(root, "bin", ".opencode"), path.join(root, "bin", "opencode"), nested].sort())
    if (!windows) return t.skip("running-image preflight is Windows-only")
    // A read-only file fails the same write-open preflight as a mapped image.
    await chmod(nested, 0o444)
    const calls: string[] = []
    try {
      await assert.rejects(installSharedOpenCode("2.0.30", { ...host, node: process.execPath, npm: "fixture-npm.js", probe,
        execute: installer(prefix, calls), registerPath: async () => {}, replaceLegacy: { path: command, version: "1.15.0" } }),
      (error: unknown) => error instanceof InstallationBusyError && error.code === "installation_in_use")
    } finally { await chmod(nested, 0o644) }
    assert.deepEqual(calls, [], "npm never runs while a native image is in use")
    assert.equal(sharedInstallationPlan(host).legacy?.version, "1.15.0", "nothing was removed")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("npm uninstall failures report whether OpenCode 1.x is still installed", async () => {
  const { home, env, host, prefix } = await environment("legacy-uninstall-")
  try {
    const command = await legacyFixture(prefix)
    env.PATH = npmCommandDirectory(prefix)
    const consent = { path: command, version: "1.18.10" }
    const attempt = (execute: (node: string, args: string[]) => Promise<void>) => installSharedOpenCode("2.0.30", {
      ...host, node: process.execPath, npm: "fixture-npm.js", probe, execute, registerPath: async () => {}, replaceLegacy: consent })
    const failure = (npmCode?: string) => Object.assign(new Error("OpenCode installation failed (1)"), npmCode ? { npmCode } : {})
    for (const code of ["EBUSY", "EPERM"]) {
      await assert.rejects(attempt(async () => { throw failure(code) }),
        (error: unknown) => error instanceof InstallationBusyError && error.code === "installation_in_use" && /still installed/.test(error.message))
    }
    await assert.rejects(attempt(async () => { throw failure("E500") }), (error: unknown) =>
      !(error instanceof LegacyReplacementError) && /still installed/.test((error as Error).message))
    assert.equal(sharedInstallationPlan(host).legacy?.version, "1.18.10")
    assert.equal(existsSync(path.join(prefix, ".codenomad-opencode-install.lock")), false)
    await assert.rejects(attempt(async () => {
      await rm(path.join(legacyNpmPackageRoot(prefix, process.platform), "bin"), { recursive: true })
      throw failure("EBUSY")
    }), (error: unknown) => error instanceof LegacyReplacementError && error.code === "legacy_partially_removed")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("foreign version probes are asynchronous, bounded and kill the process tree on timeout", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "foreign-probe-"))
  try {
    const quick = path.join(home, windows ? "quick.cmd" : "quick")
    await writeFile(quick, windows ? "@echo opencode 1.19.0\r\n" : "#!/bin/sh\necho opencode 1.19.0\n", { mode: 0o755 })
    assert.deepEqual(cachedForeignProbe(quick), undefined, "a cache miss reports unknown without spawning synchronously")
    assert.deepEqual(await probeForeignCommand(quick), { valid: true, version: "1.19.0" })
    assert.deepEqual(cachedForeignProbe(quick), { valid: true, version: "1.19.0" })
    await writeFile(quick, windows ? "@echo opencode 2.0.30 \r\n" : "#!/bin/sh\necho opencode 2.0.30 \n", { mode: 0o755 })
    assert.equal(cachedForeignProbe(quick), undefined, "a changed file invalidates the cached decision")
    assert.deepEqual(await probeForeignCommand(quick), { valid: true, version: "2.0.30" })

    const pidFile = path.join(home, "grandchild.pid")
    const script = path.join(home, "hang.js")
    await writeFile(script, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)\n")
    const hang = path.join(home, windows ? "hang.cmd" : "hang")
    await writeFile(hang, windows ? `@"${process.execPath}" "${script}" "${pidFile}"\r\n`
      : `#!/bin/sh\n"${process.execPath}" "${script}" "${pidFile}" &\nwait\n`, { mode: 0o755 })
    const started = Date.now()
    assert.equal(await probeForeignCommand(hang, { timeoutMs: 1_500 }), undefined, "a timeout is unknown, not unusable")
    assert.ok(Date.now() - started < 5_000)
    assert.equal(cachedForeignProbe(hang), undefined)
    const pid = Number(await readFile(pidFile, "utf8"))
    const deadline = Date.now() + 5_000
    let alive = true
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 100)) } catch { alive = false }
    }
    assert.equal(alive, false, "the wrapper's descendant is killed")
  } finally { await rm(home, { recursive: true, force: true }) }
})

/** A command that records each start in `<name>.runs`, then prints a version or hangs. */
async function countingCommand(home: string, name: string, behavior: "version" | "hang") {
  const runs = path.join(home, `${name}.runs`)
  const script = path.join(home, `${name}.js`)
  await writeFile(script, `require('fs').appendFileSync(${JSON.stringify(runs)}, 'x');`
    + (behavior === "version" ? "console.log('opencode 1.19.0')\n" : "setInterval(() => {}, 1000)\n"))
  const command = path.join(home, windows ? `${name}.cmd` : name)
  await writeFile(command, windows ? `@"${process.execPath}" "${script}"\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 })
  return { command, runs: async () => { try { return (await readFile(runs, "utf8")).length } catch { return 0 } } }
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test("timed-out probes are shared, not re-run on every read, and expire after a bounded delay", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "foreign-probe-ttl-"))
  try {
    const hang = await countingCommand(home, "hang", "hang")
    const options = { timeoutMs: 1_000, unknownTtlMs: 2_500 }
    // Concurrent status reads and resolution lookups join the single running probe.
    const shared = [probeForeignCommand(hang.command, options), probeForeignCommand(hang.command, options),
      probeForeignCommand(hang.command, { ...options, force: true })]
    assert.equal(cachedForeignProbe(hang.command), undefined)
    assert.deepEqual(await Promise.all(shared), [undefined, undefined, undefined])
    await settle(300)
    assert.equal(await hang.runs(), 1, "one probe for concurrent callers, including an explicit recheck")

    // Within the delay, a still-unknown command is not spawned again.
    for (let read = 0; read < 5; read++) {
      assert.equal(cachedForeignProbe(hang.command), undefined)
      assert.equal(await probeForeignCommand(hang.command, options), undefined)
    }
    await settle(300)
    assert.equal(await hang.runs(), 1, "a hanging command is not re-run on every status read")

    // After the delay, the next read probes again (e.g. once an antivirus scan finished).
    await settle(2_500)
    assert.equal(await probeForeignCommand(hang.command, options), undefined)
    await settle(300)
    assert.equal(await hang.runs(), 2, "an expired unknown is re-probed")
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("an explicit recheck re-probes immediately; definite results last until the file changes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "foreign-probe-recheck-"))
  try {
    const hang = await countingCommand(home, "hang", "hang")
    assert.equal(await probeForeignCommand(hang.command, { timeoutMs: 1_000 }), undefined)
    await settle(300)
    assert.equal(await probeForeignCommand(hang.command, { timeoutMs: 1_000 }), undefined)
    await settle(300)
    assert.equal(await hang.runs(), 1, "the default delay keeps the unknown result")
    assert.equal(await probeForeignCommand(hang.command, { timeoutMs: 1_000, force: true }), undefined)
    await settle(300)
    assert.equal(await hang.runs(), 2, "the explicit recheck spawns a fresh probe within the delay")

    const quick = await countingCommand(home, "quick", "version")
    assert.deepEqual(await probeForeignCommand(quick.command, { unknownTtlMs: 1 }), { valid: true, version: "1.19.0" })
    await settle(50)
    assert.deepEqual(cachedForeignProbe(quick.command), { valid: true, version: "1.19.0" }, "definite results do not expire")
    assert.deepEqual(await probeForeignCommand(quick.command), { valid: true, version: "1.19.0" })
    assert.equal(await quick.runs(), 1)
    assert.deepEqual(await probeForeignCommand(quick.command, { force: true }), { valid: true, version: "1.19.0" })
    assert.equal(await quick.runs(), 2, "an explicit recheck also refreshes a definite result")
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
