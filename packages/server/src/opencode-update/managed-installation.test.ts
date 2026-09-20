import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installManagedOpenCode, readManagedExecutable } from "./managed-installation"

test("failed install never changes the selected version; verified install publishes atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-installer-"))
  try {
    let correct = false
    const options = { root, node: process.execPath, npm: "fixture-npm.js",
      execute: async (file: string, args: string[], env: NodeJS.ProcessEnv) => {
        assert.equal(file, process.execPath)
        assert.ok(args.includes("@opencode/cli@2.0.11"))
        assert.ok(Object.entries(env).some(([key, value]) => key.toLowerCase() === "path" && value?.startsWith(path.dirname(process.execPath))))
        const staging = args[args.indexOf("--prefix") + 1]!
        await mkdir(path.join(staging, "node_modules/@opencode/cli/bin"), { recursive: true })
        await writeFile(path.join(staging, "node_modules/@opencode/cli/bin/opencode.exe"), "fixture")
      },
      probe: (file: string) => ({ valid: correct && file.includes(".install-"), version: correct && file.includes(".install-") ? "2.0.11" : undefined }),
    }
    await assert.rejects(installManagedOpenCode("2.0.11", options), /verification failed/)
    assert.equal(readManagedExecutable(root), undefined)
    correct = true
    const binary = await installManagedOpenCode("2.0.11", options)
    assert.equal(readManagedExecutable(root), binary)
    await assert.rejects(installManagedOpenCode("2.0.10", options), /opencode_update_required/)
    assert.equal(readManagedExecutable(root), binary)
  } finally { await rm(root, { recursive: true, force: true }) }
})
