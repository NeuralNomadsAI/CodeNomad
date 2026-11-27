import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, symlink, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { productRuntime, repo, rewriteFixtureImports } from "./fixtures.mjs"
import { buildHardeningGitEnv } from "./hardening.mjs"
import { outsideUserHome } from "./private-profile.mjs"

const execFileAsync = promisify(execFile)

test("fixtures.mjs rewrites all relative native-fixture imports and productRuntime() imports cleanly", async () => {
  const source = path.join(repo, "scripts/native-product-fixture.mjs")
  const sample = [
    'import { createAttestedFetch } from "./native-fixture-http.mjs"',
    "import { spawnFixtureChild } from './native-fixture-guards.mjs'",
    'export { pidAlive } from "./native-fixture-process.mjs"',
    'const ver = await import("./native-fixture-cli-version.mjs")',
    'const note = "keep literal ./native-fixture-http.mjs untouched"',
  ].join("\n")

  const rewritten = rewriteFixtureImports(sample, source)
  for (const name of [
    "native-fixture-http.mjs",
    "native-fixture-guards.mjs",
    "native-fixture-process.mjs",
    "native-fixture-cli-version.mjs",
  ]) {
    const expectedUrl = pathToFileURL(path.join(repo, "scripts", name)).href
    assert.ok(rewritten.includes(JSON.stringify(expectedUrl)), `expected rewritten URL for ${name}`)
  }
  assert.ok(rewritten.includes('const note = "keep literal ./native-fixture-http.mjs untouched"'))
  assert.throws(
    () => rewriteFixtureImports('import { x } from "./native-fixture-does-not-exist.mjs"', source),
    /Missing relative import target/,
  )

  const first = await productRuntime({ gitCeiling: true })
  const second = await productRuntime({ holdProvider: "fixture-hold", gitCeiling: false })
  try {
    assert.notEqual(first.file, second.file)
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
    await first.remove()
    await second.remove()
  }
  assert.equal(existsSync(first.file), false)
  assert.equal(existsSync(second.file), false)
})

test("every OpenCode bench script refuses executables inside the user home directly or via link", async () => {
  const scratch = await mkdtemp(path.join(await outsideUserHome(import.meta.dirname), "bench-m14-"))
  const junction = path.join(scratch, "home-link")
  const homeExe = path.join(os.homedir(), ".codenomad-bench-guard-nonexistent", "opencode.exe")
  const linkedExe = path.join(junction, ".codenomad-bench-guard-nonexistent", "opencode.exe")
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

    for (const [script, buildArgs] of invocations) {
      const scriptPath = path.join(import.meta.dirname, script)
      for (const [targetExe, expectedPattern] of [
        [homeExe, /outside the user's home/],
        [linkedExe, /resolves inside the user's home/],
      ]) {
        await assert.rejects(
          execFileAsync(process.execPath, [scriptPath, ...buildArgs(targetExe)], {
            windowsHide: true,
            timeout: 15_000,
          }),
          error => error.code !== 0 && expectedPattern.test(String(error.stderr)),
          `${script} must refuse ${targetExe}`,
        )
      }
    }

    if (process.platform === "win32") {
      const runAll = path.join(import.meta.dirname, "run-all.ps1")
      await assert.rejects(
        execFileAsync("pwsh", ["-NoProfile", "-File", runAll, "-OpenCode", homeExe, "-Only", "http"], {
          windowsHide: true,
          timeout: 15_000,
        }),
        error => error.code !== 0 && /outside the user's home|Refused OpenCode executable/.test(`${error.stderr}\n${error.stdout}`),
        "run-all.ps1 must refuse a user-home OpenCode executable",
      )
    }
  } finally {
    await unlink(junction).catch(() => {})
    await rm(scratch, { recursive: true, force: true })
  }
})

test("hardening.mjs strips inherited GIT_* variables before running git", () => {
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
    for (const key of [
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
    ]) {
      assert.equal(Object.hasOwn(clean, key), false, `expected ${key} to be stripped`)
    }
  }
})
