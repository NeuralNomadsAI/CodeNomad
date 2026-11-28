import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { buildHardeningChildEnv, buildHardeningGitEnv } from "./hardening.mjs"
import {
  assertPrivateHost,
  assertPrivateOpenCodeExecutable,
  assertPrivateProfile,
  assertPrivateTsServerLaunch,
  outsideUserHome,
  resolveSystemPowerShell,
  sanitizeBenchEnvPath,
  sanitizeBenchPath,
} from "./private-profile.mjs"

const execFileAsync = promisify(execFile)
const benchOutDir = path.join(import.meta.dirname, "out")

async function snapshotTree(directory, base = directory) {
  if (!existsSync(directory)) return null
  const rows = []
  const entries = (await readdir(directory)).sort()
  for (const name of entries) {
    const full = path.join(directory, name)
    const rel = path.relative(base, full)
    const info = await lstat(full)
    if (info.isDirectory()) {
      rows.push([rel, "dir", 0, 0, ""])
      rows.push(...await snapshotTree(full, base))
    } else if (info.isFile()) {
      const digest = createHash("sha256").update(await readFile(full)).digest("hex")
      rows.push([rel, "file", info.size, Math.trunc(info.mtimeMs), digest])
    } else {
      rows.push([rel, "other", info.size, Math.trunc(info.mtimeMs), ""])
    }
  }
  return rows
}

test("every OpenCode bench script refuses home, linked-home and non-local executables with zero out/ side effects", async () => {
  // Remove an empty out/ directory if present so this test also catches premature out/ creation.
  await rmdir(benchOutDir).catch(() => {})
  const outExistedBefore = existsSync(benchOutDir)
  const treeBefore = await snapshotTree(benchOutDir)

  const scratch = await mkdtemp(path.join(await outsideUserHome(import.meta.dirname), "bench-m14-"))
  const junction = path.join(scratch, "home-link")
  const homeExe = path.join(os.homedir(), ".codenomad-bench-guard-nonexistent", "opencode.exe")
  const linkedExe = path.join(junction, ".codenomad-bench-guard-nonexistent", "opencode.exe")
  const uncExe = String.raw`\\localhost\C$\codenomad-bench-guard-nonexistent\opencode.exe`
  const fakeBin = path.join(scratch, "codenomad-rs.exe")
  const fakePlugins = path.join(scratch, "plugins")

  try {
    await symlink(os.homedir(), junction, process.platform === "win32" ? "junction" : "dir")

    const invocations = [
      ["compare.mjs", exe => ["http", exe]],
      ["service.mjs", exe => [exe]],
      ["security.mjs", exe => [exe]],
      ["hardening.mjs", exe => [exe]],
      ["roundtrip.mjs", exe => [exe]],
      ["host-survey.mjs", exe => [exe]],
      ["missions-human.mjs", exe => [exe, fakeBin, fakePlugins]],
    ]

    const cases = [
      [homeExe, /outside the user's home/],
      [linkedExe, /resolves inside the user's home/],
      ...(process.platform === "win32" ? [[uncExe, /drive-qualified local path/]] : []),
    ]

    for (const [script, buildArgs] of invocations) {
      const scriptPath = path.join(import.meta.dirname, script)
      for (const [targetExe, expectedPattern] of cases) {
        await assert.rejects(
          execFileAsync(process.execPath, [scriptPath, ...buildArgs(targetExe)], {
            windowsHide: true,
            timeout: 30_000,
          }),
          error => error.code !== 0 && expectedPattern.test(String(error.stderr)),
          `${script} must refuse ${targetExe}`,
        )
      }
    }
    assert.equal(existsSync(benchOutDir), outExistedBefore, "refused bench scripts must not create out/")
    assert.deepEqual(await snapshotTree(benchOutDir), treeBefore, "refused bench scripts must not modify out/")

    const tsServerScript = path.join(import.meta.dirname, "ts-server.mjs")
    const tsProfileRoot = path.join(scratch, "ts-profile")
    await mkdir(tsProfileRoot, { recursive: true })
    const baseTsEnv = {
      ...process.env,
      HOME: tsProfileRoot,
      USERPROFILE: tsProfileRoot,
      APPDATA: path.join(tsProfileRoot, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(tsProfileRoot, "AppData", "Local"),
      XDG_CONFIG_HOME: path.join(tsProfileRoot, "xdg-config"),
      XDG_DATA_HOME: path.join(tsProfileRoot, "xdg-data"),
      XDG_STATE_HOME: path.join(tsProfileRoot, "xdg-state"),
      XDG_CACHE_HOME: path.join(tsProfileRoot, "xdg-cache"),
    }
    delete baseTsEnv.CLI_CONFIG
    delete baseTsEnv.npm_config_prefix
    delete baseTsEnv.NPM_CONFIG_PREFIX

    await assert.rejects(
      execFileAsync(process.execPath, [tsServerScript], {
        env: { ...process.env, CLI_CONFIG: "" },
        windowsHide: true,
        timeout: 30_000,
      }),
      error => error.code !== 0 && /explicit absolute private path/.test(String(error.stderr)),
      "direct ts-server.mjs without private config must refuse",
    )
    const safeConfig = path.join(tsProfileRoot, "safe.yaml")
    await writeFile(safeConfig, "server: {}\n")
    await assert.rejects(
      execFileAsync(process.execPath, [tsServerScript, "--config", safeConfig], {
        env: { ...baseTsEnv, npm_config_prefix: path.join(os.homedir(), ".npm-global") },
        windowsHide: true,
        timeout: 30_000,
      }),
      error => error.code !== 0 && /outside the user's home/.test(String(error.stderr)),
      "direct ts-server.mjs with user-home npm_config_prefix must refuse",
    )
    for (let idx = 0; idx < cases.length; idx += 1) {
      const [targetExe, expectedPattern] = cases[idx]
      const badConfig = path.join(tsProfileRoot, `bad-${idx}.yaml`)
      await writeFile(badConfig, `server:\n  opencodeBinary: ${JSON.stringify(targetExe)}\n`)
      await assert.rejects(
        execFileAsync(process.execPath, [tsServerScript, "--config", badConfig], {
          env: baseTsEnv,
          windowsHide: true,
          timeout: 30_000,
        }),
        error => error.code !== 0 && expectedPattern.test(String(error.stderr)),
        `direct ts-server.mjs must refuse configured opencodeBinary ${targetExe}`,
      )
    }
    assert.equal(existsSync(benchOutDir), outExistedBefore, "refused ts-server.mjs must not create out/")
    assert.deepEqual(await snapshotTree(benchOutDir), treeBefore, "refused ts-server.mjs must not modify out/")

    if (process.platform === "win32") {
      const runAll = path.join(import.meta.dirname, "run-all.ps1")
      let substDrive = null
      try {
        for (const letter of ["Z", "Y", "X", "W", "V", "U", "T", "S", "R", "Q"]) {
          if (!existsSync(`${letter}:\\`)) {
            await execFileAsync("subst", [`${letter}:`, os.homedir()], { windowsHide: true, timeout: 10_000 })
            substDrive = letter
            break
          }
        }
        const psCases = [
          ...cases,
          ...(substDrive ? [[`${substDrive}:\\.codenomad-bench-guard-nonexistent\\opencode.exe`, /resolves inside the user's home/]] : []),
        ]
        for (const [targetExe, expectedPattern] of psCases) {
          await assert.rejects(
            execFileAsync("pwsh", ["-NoProfile", "-File", runAll, "-OpenCode", targetExe, "-Only", "http"], {
              cwd: scratch,
              windowsHide: true,
              timeout: 15_000,
            }),
            error => error.code !== 0 && expectedPattern.test(`${error.stderr}\n${error.stdout}`),
            `run-all.ps1 must refuse ${targetExe} with ${expectedPattern}`,
          )
        }
      } finally {
        if (substDrive) {
          await execFileAsync("subst", [`${substDrive}:`, "/D"], { windowsHide: true, timeout: 10_000 }).catch(() => {})
        }
      }
      assert.equal(existsSync(benchOutDir), outExistedBefore, "refused run-all.ps1 must not create out/")
      assert.deepEqual(await snapshotTree(benchOutDir), treeBefore, "refused run-all.ps1 must not modify out/")
      assert.equal(existsSync(path.join(scratch, "out")), false, "refused run-all.ps1 must not create out/ in caller cwd")
    }
  } finally {
    await unlink(junction).catch(() => {})
    await rm(scratch, { recursive: true, force: true })
  }
})

test("fixtures.mjs rewrites ESM relative imports accurately and productRuntime() creates unique atomic modules", async () => {
  const { productRuntime, repo, rewriteFixtureImports } = await import("./fixtures.mjs")
  const source = path.join(repo, "scripts/native-product-fixture.mjs")
  const httpUrl = pathToFileURL(path.join(repo, "scripts/native-fixture-http.mjs")).href
  const guardsUrl = pathToFileURL(path.join(repo, "scripts/native-fixture-guards.mjs")).href
  const processUrl = pathToFileURL(path.join(repo, "scripts/native-fixture-process.mjs")).href
  const cliVerUrl = pathToFileURL(path.join(repo, "scripts/native-fixture-cli-version.mjs")).href

  const sample = [
    '// import { fake } from "./native-fixture-http.mjs"',
    '/* export * from "./native-fixture-guards.mjs" */',
    'import /* c1 */ { createAttestedFetch } /* c2 */ from /* c3 */ "./native-fixture-http.mjs?v=1#top"',
    'import from from "./native-fixture-http.mjs"',
    'import as from "./native-fixture-http.mjs"',
    'import * as from from "./native-fixture-guards.mjs"',
    'import * as as from "./native-fixture-process.mjs"',
    'import def, * as from from "./native-fixture-process.mjs"',
    'import as, * as from from "./native-fixture-guards.mjs"',
    "import /* side */ './native-fixture-guards.mjs#sec'",
    'export /* re */ { pidAlive } from /* c4 */ "./native-fixture-process.mjs?x=2"',
    'export * /* star */ from "./native-fixture-cli-version.mjs"',
    'export * as from from "./native-fixture-cli-version.mjs"',
    'const ver = await import(/* dyn */ "./native-fixture-cli-version.mjs?dyn=1")',
    'const tpl = `from "./native-fixture-http.mjs" ${/from "\\.\\/native-fixture-http\\.mjs"/} ${await import("./native-fixture-guards.mjs")}`',
    'const re = /from "\\.\\/native-fixture-http\\.mjs"/',
    'const ratio = { a: 1 } / 2; const afterDiv = await import("./native-fixture-http.mjs"); const half = 1 / 2',
    'const fnDiv = function () { return 1 } / 2; const afterFnDiv = await import("./native-fixture-http.mjs"); const halfFn = 1 / 2',
    'const asyncFnDiv = async function* gen() { yield 1 } / 2; const afterAsyncFnDiv = await import("./native-fixture-guards.mjs"); const halfAsyncFn = 1 / 2',
    'const clsDiv = class Foo extends Base { } / 2; const afterClsDiv = await import("./native-fixture-process.mjs"); const halfCls = 1 / 2',
    'const memberClsDiv = class extends ns.class { } / 2; const afterMemberClsDiv = await import("./native-fixture-http.mjs"); const halfMCls = 1 / 2',
    'if (ok) { noop() } /from "\\.\\/native-fixture-http\\.mjs"/.test(s)',
    'function decl() {} /from "\\.\\/native-fixture-http\\.mjs"/.test(s)',
    'const computed = import("./native-fixture-http.mjs" + suffix)',
    'const member = obj.import("./native-fixture-http.mjs")',
    'const keyObj = { import: "./native-fixture-http.mjs" }',
    'const note = "keep literal ./native-fixture-http.mjs untouched"',
  ].join("\n")

  const rewritten = rewriteFixtureImports(sample, source)
  assert.ok(rewritten.includes('// import { fake } from "./native-fixture-http.mjs"'))
  assert.ok(rewritten.includes('/* export * from "./native-fixture-guards.mjs" */'))
  assert.ok(rewritten.includes(`from /* c3 */ ${JSON.stringify(`${httpUrl}?v=1#top`)}`))
  assert.ok(rewritten.includes(`import from from ${JSON.stringify(httpUrl)}`))
  assert.ok(rewritten.includes(`import as from ${JSON.stringify(httpUrl)}`))
  assert.ok(rewritten.includes(`import * as from from ${JSON.stringify(guardsUrl)}`))
  assert.ok(rewritten.includes(`import * as as from ${JSON.stringify(processUrl)}`))
  assert.ok(rewritten.includes(`import def, * as from from ${JSON.stringify(processUrl)}`))
  assert.ok(rewritten.includes(`import as, * as from from ${JSON.stringify(guardsUrl)}`))
  assert.ok(rewritten.includes(`import /* side */ ${JSON.stringify(`${guardsUrl}#sec`)}`))
  assert.ok(rewritten.includes(`from /* c4 */ ${JSON.stringify(`${processUrl}?x=2`)}`))
  assert.ok(rewritten.includes(`export * /* star */ from ${JSON.stringify(cliVerUrl)}`))
  assert.ok(rewritten.includes(`export * as from from ${JSON.stringify(cliVerUrl)}`))
  assert.ok(rewritten.includes(`import(/* dyn */ ${JSON.stringify(`${cliVerUrl}?dyn=1`)})`))
  assert.ok(rewritten.includes('`from "./native-fixture-http.mjs" ${/from "\\.\\/native-fixture-http\\.mjs"/} ${await import(' + JSON.stringify(guardsUrl) + ')}`'))
  assert.ok(rewritten.includes('const re = /from "\\.\\/native-fixture-http\\.mjs"/'))
  assert.ok(rewritten.includes(`const ratio = { a: 1 } / 2; const afterDiv = await import(${JSON.stringify(httpUrl)}); const half = 1 / 2`))
  assert.ok(rewritten.includes(`const fnDiv = function () { return 1 } / 2; const afterFnDiv = await import(${JSON.stringify(httpUrl)}); const halfFn = 1 / 2`))
  assert.ok(rewritten.includes(`const asyncFnDiv = async function* gen() { yield 1 } / 2; const afterAsyncFnDiv = await import(${JSON.stringify(guardsUrl)}); const halfAsyncFn = 1 / 2`))
  assert.ok(rewritten.includes(`const clsDiv = class Foo extends Base { } / 2; const afterClsDiv = await import(${JSON.stringify(processUrl)}); const halfCls = 1 / 2`))
  assert.ok(rewritten.includes(`const memberClsDiv = class extends ns.class { } / 2; const afterMemberClsDiv = await import(${JSON.stringify(httpUrl)}); const halfMCls = 1 / 2`))
  assert.ok(rewritten.includes('if (ok) { noop() } /from "\\.\\/native-fixture-http\\.mjs"/.test(s)'))
  assert.ok(rewritten.includes('function decl() {} /from "\\.\\/native-fixture-http\\.mjs"/.test(s)'))
  assert.ok(rewritten.includes('const computed = import("./native-fixture-http.mjs" + suffix)'))
  assert.ok(rewritten.includes('const member = obj.import("./native-fixture-http.mjs")'))
  assert.ok(rewritten.includes('const keyObj = { import: "./native-fixture-http.mjs" }'))
  assert.ok(rewritten.includes('const note = "keep literal ./native-fixture-http.mjs untouched"'))

  assert.throws(
    () => rewriteFixtureImports('import { x } from "./native-fixture-does-not-exist.mjs?v=1"', source),
    /Missing relative import target/,
  )
  assert.throws(
    () => rewriteFixtureImports('// from "./native-fixture-http.mjs"\nconst a = 1', source),
    /Expected at least one relative import/,
  )

  let first
  let second
  try {
    first = await productRuntime({ gitCeiling: true })
    second = await productRuntime({ holdProvider: "fixture-hold", gitCeiling: false })
    assert.notEqual(first.file, second.file)
    assert.match(path.basename(first.file), /^native-product-fixture-\d+-[0-9a-f-]{36}\.mjs$/)
    assert.equal(typeof first.withProductRuntime, "function")
    assert.equal(typeof second.withProductRuntime, "function")
    for (const runtime of [first, second]) {
      const generated = await readFile(runtime.file, "utf8")
      assert.doesNotMatch(generated, /\bfrom\s*["']\.\/native-fixture-/)
      for (const helper of ["native-fixture-http.mjs", "native-fixture-guards.mjs"]) {
        const expectedUrl = pathToFileURL(path.join(repo, "scripts", helper)).href
        assert.ok(generated.includes(JSON.stringify(expectedUrl)), `generated module missing ${helper} URL`)
      }
    }
  } finally {
    await Promise.allSettled([first?.remove(), second?.remove()])
  }
  assert.equal(existsSync(first.file), false)
  assert.equal(existsSync(second.file), false)
})

test("assertPrivateOpenCodeExecutable rejects non-local volumes and fails closed on Unix mounts", async () => {
  const scratch = await mkdtemp(path.join(await outsideUserHome(import.meta.dirname), "bench-vol-"))
  try {
    const privateBin = path.join(scratch, "bin", "opencode.exe")
    if (process.platform === "win32") {
      await assert.rejects(
        assertPrivateOpenCodeExecutable(privateBin, { probeDriveType: () => "Network" }),
        /reside on a local volume/,
      )
      await assert.rejects(
        assertPrivateOpenCodeExecutable(privateBin, { probeDriveType: () => "NoRootDirectory" }),
        /reside on a local volume/,
      )
      assert.equal(await assertPrivateOpenCodeExecutable(privateBin, { probeDriveType: () => "Fixed" }), privateBin)
      assert.equal(await assertPrivateOpenCodeExecutable(privateBin, { probeDriveType: () => "Ram" }), privateBin)
      await assert.rejects(
        assertPrivateOpenCodeExecutable(String.raw`\\localhost\C$\fixture\opencode.exe`),
        /drive-qualified local path/,
      )
      await assert.rejects(
        assertPrivateOpenCodeExecutable(String.raw`\\?\C:\fixture\opencode.exe`),
        /drive-qualified local path/,
      )
      await assert.rejects(
        assertPrivateOpenCodeExecutable(String.raw`\fixture\opencode.exe`),
        /drive-qualified local path/,
      )
    }
    await assert.rejects(
      assertPrivateOpenCodeExecutable(privateBin, {
        platform: "linux",
        readMounts: async () => `server:/share ${scratch} nfs4 rw 0 0\n`,
      }),
      /reside on a local volume/,
    )
    await assert.rejects(
      assertPrivateOpenCodeExecutable(privateBin, {
        platform: "linux",
        readMounts: async () => `custom ${scratch} fuse.unknown rw 0 0\n`,
      }),
      /reside on a local volume/,
    )
    await assert.rejects(
      assertPrivateOpenCodeExecutable(privateBin, {
        platform: "linux",
        readMounts: async () => "",
      }),
      /reside on a local volume/,
    )
    await assert.rejects(
      assertPrivateOpenCodeExecutable(privateBin, {
        platform: "linux",
        readMounts: async () => { throw new Error("EACCES") },
      }),
      /mount check failed/,
    )
    assert.equal(
      await assertPrivateOpenCodeExecutable(privateBin, {
        platform: "linux",
        readMounts: async () => `/dev/sda1 ${scratch} ext4 rw 0 0\n`,
      }),
      privateBin,
    )
    await assert.rejects(
      assertPrivateOpenCodeExecutable(privateBin, {
        platform: "darwin",
        readDarwinMounts: async () => `//server/share on ${scratch} (smbfs, nodev)\n`,
      }),
      /reside on a local volume/,
    )
    await assert.rejects(
      assertPrivateOpenCodeExecutable(privateBin, {
        platform: "darwin",
        readDarwinMounts: async () => { throw new Error("mount failed") },
      }),
      /mount check failed/,
    )
    assert.equal(
      await assertPrivateOpenCodeExecutable(privateBin, {
        platform: "darwin",
        readDarwinMounts: async () => `/dev/disk3s1s1 on ${scratch} (apfs, local, journaled)\n`,
      }),
      privateBin,
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test("PATH sanitization strips user-home, link-to-home, non-local, external OpenCode and escaping fixture links", async () => {
  const scratch = await mkdtemp(path.join(await outsideUserHome(import.meta.dirname), "bench-path-"))
  const junction = path.join(scratch, "home-link")
  const safeBin = path.join(scratch, "safe-bin")
  const foreignOpenCodeBin = path.join(scratch, "foreign-opencode")
  const allowedRoot = path.join(scratch, "fixture-root")
  const ownedOpenCodeBin = path.join(allowedRoot, "bin")
  const escapingFixtureBin = path.join(allowedRoot, "escaping-bin")
  const escapingShim = path.join(escapingFixtureBin, process.platform === "win32" ? "opencode2.cmd" : "opencode2")

  try {
    await mkdir(safeBin, { recursive: true })
    await mkdir(foreignOpenCodeBin, { recursive: true })
    await mkdir(ownedOpenCodeBin, { recursive: true })
    await mkdir(escapingFixtureBin, { recursive: true })
    await symlink(os.homedir(), junction, process.platform === "win32" ? "junction" : "dir")
    const shimName = process.platform === "win32" ? "opencode2.cmd" : "opencode2"
    await writeFile(path.join(foreignOpenCodeBin, shimName), "stub")
    await writeFile(path.join(ownedOpenCodeBin, shimName), "stub")
    let fileSymlinkCreated = false
    try {
      await symlink(path.join(os.homedir(), ".codenomad-bench-guard-nonexistent", shimName), escapingShim, "file")
      fileSymlinkCreated = true
    } catch (error) {
      if (process.platform !== "win32" || error.code !== "EPERM") throw error
    }

    const delimiter = process.platform === "win32" ? ";" : ":"
    const rawEntries = [
      "relative/bin",
      ...(process.platform === "win32" ? [String.raw`\\server\share\bin`] : []),
      os.homedir(),
      path.join(os.homedir(), "AppData", "Roaming", "npm"),
      junction,
      foreignOpenCodeBin,
      ...(fileSymlinkCreated ? [escapingFixtureBin] : []),
      ownedOpenCodeBin,
      safeBin,
    ]
    const cleaned = await sanitizeBenchPath(rawEntries.join(delimiter), { allowedRoot })
    const kept = cleaned.split(delimiter).filter(Boolean)
    assert.deepEqual(kept, [ownedOpenCodeBin, safeBin])

    const env = { Path: rawEntries.join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" }
    await sanitizeBenchEnvPath(env, { allowedRoot })
    assert.equal(Object.hasOwn(env, "Path"), false)
    assert.equal(env.PATH, [ownedOpenCodeBin, safeBin].join(delimiter))

    const profileNames = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLI_CONFIG"]
    const profileEnv = Object.fromEntries(profileNames.map(name => [name, path.join(allowedRoot, name)]))
    const location = { baseDir: allowedRoot, configYamlPath: path.join(allowedRoot, "config.yaml") }
    await assertPrivateProfile(allowedRoot, { ...profileEnv, PATH: env.PATH }, location)
    await assert.rejects(
      assertPrivateProfile(allowedRoot, { ...profileEnv, PATH: [safeBin, os.homedir()].join(delimiter) }, location),
      /user home entry/,
    )
    await assert.rejects(
      assertPrivateProfile(allowedRoot, { ...profileEnv, PATH: [safeBin, foreignOpenCodeBin].join(delimiter) }, location),
      /exposes external OpenCode/,
    )
    if (fileSymlinkCreated) {
      await assert.rejects(
        assertPrivateProfile(allowedRoot, { ...profileEnv, PATH: [safeBin, escapingFixtureBin].join(delimiter) }, location),
        /exposes external OpenCode/,
      )
    }
    const hostEnv = { ...profileEnv, HOME: allowedRoot, USERPROFILE: allowedRoot, CLI_CONFIG: path.join(allowedRoot, "config.yaml") }
    await assertPrivateHost({ ...hostEnv, PATH: env.PATH }, allowedRoot)
    await assert.rejects(
      assertPrivateHost({ ...hostEnv, PATH: [safeBin, foreignOpenCodeBin].join(delimiter) }, allowedRoot),
      /exposes external OpenCode/,
    )
  } finally {
    await unlink(escapingShim).catch(() => {})
    await unlink(junction).catch(() => {})
    await rm(scratch, { recursive: true, force: true })
  }
})

test("hardening.mjs and fixtures.mjs strip inherited GIT_* variables before running git", async () => {
  const { buildPrivateGitEnv, repo } = await import("./fixtures.mjs")
  const poisoned = {
    PATH: "C:\\Windows\\System32",
    SYSTEMROOT: "C:\\Windows",
    GIT_DIR: "C:\\outside\\.git",
    GIT_WORK_TREE: "C:\\outside",
    GIT_INDEX_FILE: "C:\\outside\\index",
    GIT_CONFIG_PARAMETERS: "'core.hooksPath=C:\\evil'",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "evil.cmd",
    GIT_OBJECT_DIRECTORY: "C:\\outside\\objects",
    GIT_CEILING_DIRECTORIES: "C:\\",
    git_alternate_object_directories: "C:\\outside\\alt",
  }
  const strippedKeys = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_OBJECT_DIRECTORY",
    "GIT_CEILING_DIRECTORIES",
    "git_alternate_object_directories",
  ]

  for (const [platform, expectedGlobal] of [["win32", "NUL"], ["linux", "/dev/null"]]) {
    const clean = buildHardeningGitEnv(poisoned, platform)
    assert.equal(clean.PATH, poisoned.PATH)
    assert.equal(clean.SYSTEMROOT, poisoned.SYSTEMROOT)
    assert.equal(clean.GIT_CONFIG_GLOBAL, expectedGlobal)
    assert.equal(clean.GIT_CONFIG_NOSYSTEM, "1")
    assert.equal(clean.GIT_AUTHOR_NAME, "a")
    assert.equal(clean.GIT_AUTHOR_EMAIL, "a@a")
    assert.equal(clean.GIT_COMMITTER_NAME, "a")
    assert.equal(clean.GIT_COMMITTER_EMAIL, "a@a")
    for (const key of strippedKeys) {
      assert.equal(Object.hasOwn(clean, key), false, `hardening: expected ${key} to be stripped`)
    }

    const child = buildHardeningChildEnv(poisoned, { CNRS_FIXTURE_INGRESS: "1" }, platform)
    assert.equal(child.PATH, poisoned.PATH)
    assert.equal(child.SYSTEMROOT, poisoned.SYSTEMROOT)
    assert.equal(child.CNRS_FIXTURE_INGRESS, "1")
    assert.equal(child.GIT_CONFIG_GLOBAL, expectedGlobal)
    assert.equal(child.GIT_CONFIG_NOSYSTEM, "1")
    for (const key of strippedKeys) {
      assert.equal(Object.hasOwn(child, key), false, `hardening child: expected ${key} to be stripped`)
    }
  }

  const fixtureFolder = path.join(repo, "packages/server-rs/bench/out/fake-repo")
  const privateEnv = buildPrivateGitEnv(fixtureFolder, poisoned)
  assert.equal(privateEnv.PATH, poisoned.PATH)
  assert.equal(privateEnv.SYSTEMROOT, poisoned.SYSTEMROOT)
  assert.equal(privateEnv.GIT_CONFIG_NOSYSTEM, "1")
  assert.equal(privateEnv.GIT_CONFIG_GLOBAL, path.join(path.dirname(fixtureFolder), "fixture.gitconfig"))
  for (const key of strippedKeys) {
    assert.equal(Object.hasOwn(privateEnv, key), false, `fixtures: expected ${key} to be stripped`)
  }
})

test("Windows drive probing never runs before canonical/home checks and validates SystemRoot", async () => {
  const scratch = await mkdtemp(path.join(await outsideUserHome(import.meta.dirname), "bench-ps-"))
  const junction = path.join(scratch, "home-link")
  const loopA = path.join(scratch, "loop-a")
  const loopB = path.join(scratch, "loop-b")
  try {
    await symlink(os.homedir(), junction, process.platform === "win32" ? "junction" : "dir")
    let probes = 0
    const countingProbe = () => { probes += 1; return "Fixed" }
    await assert.rejects(
      assertPrivateOpenCodeExecutable(path.join(junction, "opencode.exe"), { probeDriveType: countingProbe }),
      /resolves inside the user's home/,
    )
    assert.equal(probes, 0, "junction to user home must refuse before drive probing")

    let loopCreated = false
    try {
      await symlink(loopB, loopA, process.platform === "win32" ? "junction" : "dir")
      await symlink(loopA, loopB, process.platform === "win32" ? "junction" : "dir")
      loopCreated = true
    } catch (error) {
      if (process.platform !== "win32" || error.code !== "EPERM") throw error
    }
    if (loopCreated) {
      await assert.rejects(
        assertPrivateOpenCodeExecutable(path.join(loopA, "opencode.exe"), { probeDriveType: countingProbe }),
        /could not be resolved|ELOOP/i,
      )
      assert.equal(probes, 0, "canonical resolution failure must refuse before drive probing")
    }

    const delimiter = process.platform === "win32" ? ";" : ":"
    const cleaned = await sanitizeBenchPath([junction, path.join(os.homedir(), "bin")].join(delimiter), {
      probeDriveType: countingProbe,
    })
    assert.equal(cleaned, "")
    assert.equal(probes, 0, "sanitizeBenchPath must filter user-home and home-junction entries before drive probing")

    if (process.platform === "win32") {
      const resolved = await resolveSystemPowerShell(process.env)
      assert.match(resolved, /^[A-Za-z]:\\.*\\powershell\.exe$/i)
      await assert.rejects(
        resolveSystemPowerShell({ SystemRoot: "Windows" }),
        /drive-qualified local Windows path/,
      )
      await assert.rejects(
        resolveSystemPowerShell({ SystemRoot: String.raw`\\evil.invalid\share` }),
        /drive-qualified local Windows path/,
      )
      await assert.rejects(
        resolveSystemPowerShell({ SystemRoot: path.join(os.homedir(), "Windows") }),
        /inside the user's home/,
      )
      await assert.rejects(
        resolveSystemPowerShell({ SystemRoot: junction }),
        /resolves inside the user's home/,
      )
      await assert.rejects(
        resolveSystemPowerShell(process.env, { probeDriveType: () => "Network" }),
        /must reside on a local volume/,
      )
      await assert.rejects(
        resolveSystemPowerShell(process.env, { probeDriveType: () => "Removable" }),
        /must reside on a local volume/,
      )
    }
  } finally {
    await unlink(loopA).catch(() => {})
    await unlink(loopB).catch(() => {})
    await unlink(junction).catch(() => {})
    await rm(scratch, { recursive: true, force: true })
  }
})

test("assertPrivateTsServerLaunch validates private profile, configured binary, npm fallback and PATH", async () => {
  const scratch = await mkdtemp(path.join(await outsideUserHome(import.meta.dirname), "bench-ts-guard-"))
  const profile = path.join(scratch, "profile")
  const safeBin = path.join(scratch, "safe-bin")
  const foreignBin = path.join(scratch, "foreign-bin")
  const privateExe = path.join(profile, "fake-opencode.cmd")
  const configYaml = path.join(profile, "ts.yaml")
  const delimiter = process.platform === "win32" ? ";" : ":"
  try {
    await mkdir(profile, { recursive: true })
    await mkdir(safeBin, { recursive: true })
    await mkdir(foreignBin, { recursive: true })
    await writeFile(privateExe, "@echo off\r\nexit /b 0\r\n")
    await writeFile(path.join(foreignBin, process.platform === "win32" ? "opencode2.cmd" : "opencode2"), "stub")
    await writeFile(configYaml, `server:\n  opencodeBinary: ${JSON.stringify(privateExe)}\n`)
    const env = {
      HOME: profile,
      USERPROFILE: profile,
      APPDATA: path.join(profile, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(profile, "AppData", "Local"),
      PATH: [os.homedir(), foreignBin, safeBin].join(delimiter),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    }
    await assertPrivateTsServerLaunch(["--config", configYaml], env, { probeDriveType: () => "Fixed" })
    assert.equal(env.PATH, safeBin)
    await assert.rejects(
      assertPrivateTsServerLaunch(["--config", ""], { ...env, CLI_CONFIG: configYaml }, { probeDriveType: () => "Fixed" }),
      /--config must not be empty/,
    )
    await assert.rejects(
      assertPrivateTsServerLaunch(["--config", configYaml, "--config", configYaml], { ...env }, { probeDriveType: () => "Fixed" }),
      /duplicate --config/,
    )

    const badConfig = path.join(profile, "bad.yaml")
    await writeFile(badConfig, `server:\n  opencodeBinary: ${JSON.stringify(path.join(os.homedir(), "opencode.exe"))}\n`)
    await assert.rejects(
      assertPrivateTsServerLaunch(["--config", badConfig], { ...env }, { probeDriveType: () => "Fixed" }),
      /outside the user's home/,
    )

    // Legacy config.json migration (`preferences.lastUsedBinary`) and sibling `config.yaml`.
    const jsonDir = path.join(profile, "legacy-json")
    await mkdir(jsonDir, { recursive: true })
    const legacyJson = path.join(jsonDir, "config.json")
    await writeFile(legacyJson, JSON.stringify({ preferences: { lastUsedBinary: path.join(os.homedir(), "opencode2.exe") } }))
    await assert.rejects(
      assertPrivateTsServerLaunch(["--config", legacyJson], { ...env }, { probeDriveType: () => "Fixed" }),
      /outside the user's home/,
    )
    await writeFile(legacyJson, JSON.stringify({ preferences: { lastUsedBinary: privateExe } }))
    await writeFile(path.join(jsonDir, "config.yaml"), `server:\n  opencodeBinary: ${JSON.stringify(path.join(os.homedir(), "opencode.exe"))}\n`)
    await assert.rejects(
      assertPrivateTsServerLaunch(["--config", legacyJson], { ...env }, { probeDriveType: () => "Fixed" }),
      /outside the user's home/,
    )

    // Custom `@opencode/cli` package.json `bin` entry pointing outside the npm package / into user home.
    const npmPrefix = process.platform === "win32" ? path.join(env.APPDATA, "npm") : path.join(env.HOME, ".local")
    const pkgRoot = path.join(npmPrefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@opencode", "cli")
    await mkdir(path.join(pkgRoot, "bin"), { recursive: true })
    await writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({
      name: "@opencode/cli",
      bin: { opencode2: "./bin/custom.exe" },
    }))
    const customTarget = path.join(pkgRoot, "bin", "custom.exe")
    await writeFile(customTarget, "stub")
    await assertPrivateTsServerLaunch(["--config", configYaml], { ...env }, { probeDriveType: () => "Fixed" })

    await writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({
      name: "@opencode/cli",
      bin: { opencode2: "../../../../../../escape.exe" },
    }))
    await assert.rejects(
      assertPrivateTsServerLaunch(["--config", configYaml], { ...env }, { probeDriveType: () => "Fixed" }),
      /escapes its npm package/,
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
