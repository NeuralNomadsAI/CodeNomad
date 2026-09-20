import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readFileSync } from "node:fs"
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
    await assert.rejects(installManagedOpenCode("2.0.6", options), /opencode_update_required/)
    for (const version of ["../outside", "3.0.0-dev.1", "custom-build"]) {
      await assert.rejects(installManagedOpenCode(version, options), /exact stable/)
    }
    assert.equal(readManagedExecutable(root), binary)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("immutable publication cannot select an older installer finishing after a newer one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-install-race-"))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const options = { root, node: process.execPath, npm: "fixture-npm.js",
    execute: async (_file: string, args: string[]) => {
      const version = args.at(-1)!.split("@").at(-1)!
      const staging = args[args.indexOf("--prefix") + 1]!
      if (version === "2.0.11") await gate
      await mkdir(path.join(staging, "node_modules/@opencode/cli/bin"), { recursive: true })
      await writeFile(path.join(staging, "node_modules/@opencode/cli/bin/opencode.exe"), version)
    },
    probe: (file: string) => {
      try { return { valid: true, version: readFileSync(file, "utf8") } }
      catch { return { valid: false } }
    },
  }
  try {
    const older = installManagedOpenCode("2.0.11", options)
    const newer = await installManagedOpenCode("2.0.12", options)
    release()
    assert.equal(await older, newer)
    assert.equal(readManagedExecutable(root), newer)
    await writeFile(path.join(root, "current"), "2.0.11")
    assert.equal(readManagedExecutable(root), newer, "old marker writers cannot downgrade receipt selection")
  } finally { release(); await rm(root, { recursive: true, force: true }) }
})

test("same-version concurrent publishers all succeed without replacing Windows receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-same-version-install-"))
  const options = { root, node: process.execPath, npm: "fixture-npm.js",
    execute: async (_file: string, args: string[]) => {
      const staging = args[args.indexOf("--prefix") + 1]!
      await mkdir(path.join(staging, "node_modules/@opencode/cli/bin"), { recursive: true })
      await writeFile(path.join(staging, "node_modules/@opencode/cli/bin/opencode.exe"), "2.0.12")
    },
    probe: (file: string) => {
      try { return { valid: true, version: readFileSync(file, "utf8") } }
      catch { return { valid: false } }
    },
  }
  try {
    for (let batch = 0; batch < 6; batch++) {
      const results = await Promise.all(Array.from({ length: 20 }, () => installManagedOpenCode("2.0.12", options)))
      assert.equal(new Set(results).size, 1)
      assert.equal(readManagedExecutable(root), results[0])
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
