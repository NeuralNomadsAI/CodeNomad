import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { hasWorkspaceLifetimeClaim } from "./workspace-lifetime-claim"

const childScript = fileURLToPath(new URL("./workspace-lifetime-claim.child.ts", import.meta.url))

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await readFile(filePath).then(() => true, () => false)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

test("workspace lifetime claims are visible across processes and stale owners retire", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-workspace-claim-test-"))
  const repositoryKey = `test:${directory}`
  const readyPath = path.join(directory, "ready")
  const stopPath = path.join(directory, "stop")
  const child = spawn(process.execPath, ["--import", "tsx", childScript, repositoryKey, readyPath, stopPath], {
    stdio: "inherit",
  })
  try {
    await waitForFile(readyPath)
    assert.equal(await hasWorkspaceLifetimeClaim(repositoryKey, "workspace"), true)
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill("SIGKILL")
    await exited
    assert.equal(await hasWorkspaceLifetimeClaim(repositoryKey, "workspace"), false)
  } finally {
    if (child.exitCode === null) {
      await writeFile(stopPath, "stop")
      child.kill()
    }
    await rm(directory, { recursive: true, force: true })
  }
})
