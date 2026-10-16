import assert from "node:assert/strict"
import test from "node:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { executeInstaller } from "./npm-runtime"
import { upgradeSharedOpenCode } from "./native-upgrade"
import { InstallationInterruptedError, withInstallationLock } from "./installation-lock"

test("timeout fences surviving installer descendants and preserves their adapter directory", { timeout: 60_000 }, async () => {
  // A loaded host can boot the supervisor more slowly than the installer
  // timeout, killing it before it has a descendant to fence. That attempt did
  // not establish the scenario, so repeat it in a fresh prefix with more time.
  for (const timeout of [1500, 5000, 15_000]) {
    if (await timeoutFencesSurvivingDescendant(timeout)) return
  }
  assert.fail("the installer supervisor never recorded its descendant before the timeout")
})

async function timeoutFencesSurvivingDescendant(timeout: number): Promise<boolean> {
  const prefix = await mkdtemp(path.join(os.tmpdir(), "installer-interruption-"))
  const record = path.join(prefix, "child-pid")
  const supervisor = path.join(prefix, "supervisor.cjs")
  let childPID: number | undefined, shimDirectory: string | undefined
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.CODENOMAD_NATIVE_PARENT
  await writeFile(supervisor, `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true, detached: true });
    writeFileSync(${JSON.stringify(record)}, String(child.pid));
    setTimeout(() => {}, 20000);
  `)
  try {
    await assert.rejects(withInstallationLock(prefix, () => upgradeSharedOpenCode({
      binary: process.execPath, version: "2.0.16", prefix, node: process.execPath, npm: supervisor, env, platform: process.platform,
      execute: async (_binary, _args, childEnv, options) => {
        shimDirectory = options!.cwd
        await executeInstaller(process.execPath, [supervisor], childEnv, { cwd: shimDirectory, timeout })
      },
    })), error => {
      assert.ok(error instanceof InstallationInterruptedError, "cleanup must preserve the interruption error")
      assert.ok(error.message.includes(path.join(prefix, ".codenomad-opencode-install.lock")))
      return true
    })
    const recorded = await readFile(record, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (recorded === undefined) return false
    childPID = Number(recorded)
    assert.ok(childPID > 0)
    process.kill(childPID, 0)
    await access(shimDirectory!)
    await assert.rejects(withInstallationLock(prefix, async () => { assert.fail("must not start another installer") }),
      { code: "installation_busy" })
    return true
  } finally {
    childPID ??= Number(await readFile(record, "utf8").catch(() => "0"))
    if (childPID) { try { process.kill(childPID) } catch { /* Already exited. */ } }
    if (shimDirectory) await rm(shimDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    await rm(prefix, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

test("output-limit termination retains the lock; ordinary installer failure releases it", async () => {
  const prefix = await mkdtemp(path.join(os.tmpdir(), "installer-output-"))
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  try {
    await assert.rejects(withInstallationLock(prefix, () => executeInstaller(process.execPath,
      ["-e", "process.exit(1)"], env)), /installation failed/)
    await assert.rejects(withInstallationLock(prefix, () => executeInstaller(process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setTimeout(() => {}, 20000)"], env)), InstallationInterruptedError)
    await assert.rejects(withInstallationLock(prefix, async () => {}), { code: "installation_busy" })
  } finally { await rm(prefix, { recursive: true, force: true }) }
})

test("npm failures expose only npm's symbolic error code for classification", async () => {
  const script = "process.stderr.write('npm error code EBUSY\\r\\nnpm error path C:\\\\private\\\\opencode.exe\\r\\n'); process.exit(1)"
  await assert.rejects(executeInstaller(process.execPath, ["-e", script], process.env), (error: unknown) =>
    (error as { npmCode?: string }).npmCode === "EBUSY" && !/private/.test((error as Error).message))
  await assert.rejects(executeInstaller(process.execPath, ["-e", "process.exit(1)"], process.env), (error: unknown) =>
    (error as { npmCode?: string }).npmCode === undefined)
})
