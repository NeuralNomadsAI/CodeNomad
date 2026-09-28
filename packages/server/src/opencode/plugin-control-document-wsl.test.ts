import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { appendPluginControlRule, PluginControlDocumentError, readPluginControlDocument, replacePluginControlDocument } from "./plugin-control-document"
import {
  createWslPluginControlDocumentFileSystem,
  type WslPluginControlExecution,
  type WslPluginControlExecutor,
} from "./plugin-control-document-wsl"

describe("WSL plugin control documents", () => {
  it("keeps native paths and source permissions in WSL operations", async () => {
    const calls: Array<{ script: string; args: readonly string[]; input?: Buffer }> = []
    const execute: WslPluginControlExecutor = async (_distro, script, args, input) => {
      calls.push({ script: firstLine(script), args, ...(input ? { input } : {}) })
      if (script.includes("# read-document")) {
        return success(Buffer.concat([
          Buffer.from(["file", "/home/dev/.config/opencode/opencode.jsonc", "600", ""].join("\0")),
          Buffer.from(`{ "plugins": [] }\n`),
        ]))
      }
      if (script.includes("# inspect-document")) {
        return success(Buffer.from("file\0/home/dev/.config/opencode/opencode.jsonc\0"))
      }
      return success()
    }
    const fileSystem = createWslPluginControlDocumentFileSystem("Ubuntu", execute)
    const document = await readPluginControlDocument("/home/dev/.config/opencode/opencode.jsonc", fileSystem)

    assert.equal(document.mode, 0o600)
    await replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), undefined, fileSystem)

    const prepare = calls.find((call) => call.script === "# prepare-document")
    assert.equal(prepare?.args[1], "/home/dev/.config/opencode/opencode.jsonc")
    assert.equal(prepare?.args[5], "600")
    assert.equal(prepare?.args[6], "600")
    assert.match(prepare?.args[8] ?? "", /^[a-f0-9]{64}$/)
    assert.match(prepare?.args[4] ?? "", /^[a-f0-9]{32}$/)
    const commit = calls.find((call) => call.script === "# commit-document")
    assert.equal(commit?.args[0], "/home/dev/.config/opencode/opencode.jsonc")
    assert.equal(commit?.args[6], "600")
    assert.equal(commit?.args[7], "600")
    assert.ok(calls.every((call) => call.args.every((value) => !value.startsWith("\\\\wsl"))))
  })

  it("maps WSL lock contention and external changes to conflicts without cleanup leaks", async () => {
    const document = {
      requestedPath: "/home/dev/.config/opencode/opencode.jsonc",
      writePath: "/home/dev/.config/opencode/opencode.jsonc",
      exists: true,
      mode: 0o600,
      text: `{ "plugins": [] }`,
      byteOrderMark: false,
      plugins: [],
    } as const
    for (const scriptName of ["# prepare-document", "# commit-document"] as const) {
      for (const status of [73, 75]) {
        const calls: string[] = []
        const execute: WslPluginControlExecutor = async (_distro, script) => {
          calls.push(firstLine(script))
          if (firstLine(script) === scriptName) return { status, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
          return success()
        }
        const fileSystem = createWslPluginControlDocumentFileSystem("Ubuntu", execute)
        await assert.rejects(
          replacePluginControlDocument(document, `{ "plugins": ["-acme"] }\n`, undefined, fileSystem),
          (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict",
        )
        assert.ok(calls.includes(scriptName))
      }
    }
  })

  it("passes the owner nonce to WSL cleanup so a stalled owner cannot reap a successor", async () => {
    const cleanups: Array<readonly string[]> = []
    const prepares: Array<readonly string[]> = []
    const execute: WslPluginControlExecutor = async (_distro, script, args) => {
      if (firstLine(script) === "# cleanup-document") cleanups.push(args)
      if (firstLine(script) === "# prepare-document") prepares.push(args)
      if (script.includes("# read-document")) {
        return success(Buffer.concat([
          Buffer.from(["file", "/home/dev/.config/opencode/opencode.jsonc", "600", ""].join("\0")),
          Buffer.from(`{ "plugins": [] }\n`),
        ]))
      }
      if (script.includes("# inspect-document")) {
        return success(Buffer.from("file\0/home/dev/.config/opencode/opencode.jsonc\0"))
      }
      return success()
    }
    const fileSystem = createWslPluginControlDocumentFileSystem("Ubuntu", execute)
    const document = await readPluginControlDocument("/home/dev/.config/opencode/opencode.jsonc", fileSystem)
    await replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), undefined, fileSystem)

    assert.equal(cleanups.length, 0, "successful commits clean up inside the commit script")
    assert.match(prepares[0]?.[4] ?? "", /^[a-f0-9]{32}$/)
  })

  it("sends the owner nonce to WSL cleanup when authorization fails after prepare", async () => {
    const cleanups: Array<readonly string[]> = []
    const prepares: Array<readonly string[]> = []
    const execute: WslPluginControlExecutor = async (_distro, script, args) => {
      if (firstLine(script) === "# cleanup-document") cleanups.push(args)
      if (firstLine(script) === "# prepare-document") prepares.push(args)
      if (script.includes("# read-document")) {
        return success(Buffer.concat([
          Buffer.from(["file", "/home/dev/.config/opencode/opencode.jsonc", "600", ""].join("\0")),
          Buffer.from(`{ "plugins": [] }\n`),
        ]))
      }
      return success()
    }
    const fileSystem = createWslPluginControlDocumentFileSystem("Ubuntu", execute)
    const document = await readPluginControlDocument("/home/dev/.config/opencode/opencode.jsonc", fileSystem)

    await assert.rejects(
      replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), {
        beforeCommit: () => { throw new Error("stale connection") },
      }, fileSystem),
      (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "filesystem",
    )

    assert.equal(cleanups.length, 1)
    assert.equal(cleanups[0]?.[1], prepares[0]?.[3])
    assert.equal(cleanups[0]?.[2], prepares[0]?.[4])
  })

  const distro = process.env.CODENOMAD_TEST_WSL_PLUGIN_CONTROLS
  it("preserves a native 0600 mode through a real WSL replacement", { skip: !distro }, async () => {
    const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
    const target = `${root}/opencode.jsonc`
    try {
      runWsl(distro!, `mkdir -m 700 -- "$1" && printf '%s\\n' '{ "plugins": [] }' > "$2" && chmod 600 -- "$2"`, root, target)
      const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
      const document = await readPluginControlDocument(target, fileSystem)
      assert.equal(document.mode, 0o600)

      await replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), undefined, fileSystem)

      assert.equal(runWsl(distro!, `stat -c '%a' -- "$1"`, target).trim(), "600")
      assert.match(runWsl(distro!, `cat -- "$1"`, target), /"-acme"/)
    } finally {
      runWsl(distro!, `rm -rf -- "$1"`, root)
    }
  })

  it("fails closed for a WSL symlink loop instead of reporting missing", { skip: !distro }, async () => {
    const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
    try {
      runWsl(distro!, `mkdir -p -- "$1" && ln -s loop -- "$1/loop"`, root)
      const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
      await assert.rejects(
        readPluginControlDocument(`${root}/loop`, fileSystem),
        (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "filesystem",
      )
    } finally {
      runWsl(distro!, `rm -rf -- "$1"`, root)
    }
  })

  it("rejects a mode-only external change in WSL as a conflict", { skip: !distro }, async () => {
    const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
    const target = `${root}/opencode.jsonc`
    try {
      runWsl(distro!, `mkdir -m 700 -- "$1" && printf '%s\\n' '{ "plugins": [] }' > "$2" && chmod 600 -- "$2"`, root, target)
      const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
      const document = await readPluginControlDocument(target, fileSystem)
      runWsl(distro!, `chmod 644 -- "$1"`, target)

      await assert.rejects(
        replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), undefined, fileSystem),
        (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict",
      )
      assert.equal(runWsl(distro!, `stat -c '%a' -- "$1"`, target).trim(), "644")
    } finally {
      runWsl(distro!, `rm -rf -- "$1"`, root)
    }
  })

  it("fails closed when the target becomes a directory before the WSL rename", { skip: !distro }, async () => {
    const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
    const target = `${root}/opencode.jsonc`
    try {
      runWsl(distro!, `mkdir -m 700 -- "$1" && printf '%s\\n' '{ "plugins": [] }' > "$2" && chmod 600 -- "$2"`, root, target)
      const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
      const document = await readPluginControlDocument(target, fileSystem)

      await assert.rejects(
        replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), {
          beforeCommit: () => runWsl(distro!, `rm -- "$1" && mkdir -- "$1"`, target),
        }, fileSystem),
        (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict",
      )
      assert.equal(runWsl(distro!, `test -d "$1" && echo dir || echo other`, target).trim(), "dir")
      assert.equal(runWsl(distro!, `ls -A "$1" | wc -l`, target).trim(), "0")
    } finally {
      runWsl(distro!, `rm -rf -- "$1"`, root)
    }
  })
})

function firstLine(script: string): string {
  return script.slice(0, script.indexOf("\n"))
}

function success(stdout = Buffer.alloc(0)): WslPluginControlExecution {
  return { status: 0, stdout, stderr: Buffer.alloc(0) }
}

function runWsl(distro: string, script: string, ...args: string[]): string {
  return execFileSync(
    "wsl.exe",
    ["--distribution", distro, "--exec", "sh", "-c", script, "codenomad-test", ...args],
    { encoding: "utf8", windowsHide: true },
  )
}
