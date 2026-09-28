import assert from "node:assert/strict"
import test from "node:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { executeInstaller } from "./npm-runtime"
import { upgradeSharedOpenCode } from "./native-upgrade"
import { InstallationInterruptedError, withInstallationLock } from "./installation-lock"

test("timeout fences surviving installer descendants and preserves their adapter directory", { timeout: 15_000 }, async () => {
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
        await executeInstaller(process.execPath, [supervisor], childEnv, { cwd: shimDirectory, timeout: 1500 })
      },
    })), error => {
      assert.ok(error instanceof InstallationInterruptedError, "cleanup must preserve the interruption error")
      assert.ok(error.message.includes(path.join(prefix, ".codenomad-opencode-install.lock")))
      return true
    })
    childPID = Number(await readFile(record, "utf8"))
    assert.ok(childPID > 0)
    process.kill(childPID, 0)
    await access(shimDirectory!)
    await assert.rejects(withInstallationLock(prefix, async () => { assert.fail("must not start another installer") }),
      { code: "installation_busy" })
  } finally {
    childPID ??= Number(await readFile(record, "utf8").catch(() => "0"))
    if (childPID) { try { process.kill(childPID) } catch { /* Already exited. */ } }
    if (shimDirectory) await rm(shimDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    await rm(prefix, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

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
