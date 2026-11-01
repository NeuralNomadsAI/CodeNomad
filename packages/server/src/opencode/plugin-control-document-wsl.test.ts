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
import { removePluginSourceEntry } from "./plugin-source-document"
import { NativeMutationAdmission, NativeMutationUncertainError, type NativeMutationAuthority } from "./native-mutation-authority"
import { PluginControls } from "./plugin-controls"
import { PluginSources } from "./plugin-sources"

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

  it("refuses revoked writer admission before dispatching any WSL command", async () => {
    const calls: string[] = []
    const fileSystem = createWslPluginControlDocumentFileSystem("fixture-only", async (_distro, script) => {
      calls.push(firstLine(script)); return success()
    })
    const document = { requestedPath: "/fixture/opencode.jsonc", writePath: "/fixture/opencode.jsonc",
      exists: false, mode: 0o600, text: "{}\n", byteOrderMark: false, plugins: [] }
    await assert.rejects(replacePluginControlDocument(document, appendPluginControlRule(document, "acme"), {
      assertCurrent: () => { throw new Error("revoked admission") },
    }, fileSystem), (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "filesystem")
    assert.deepEqual(calls, [])
  })

  it("rechecks revocable authority after WSL preparation and never dispatches a revoked commit", async () => {
    const calls: string[] = []
    let revoked = false, checks = 0
    const fileSystem = createWslPluginControlDocumentFileSystem("fixture-only", async (_distro, script) => {
      const name = firstLine(script)
      calls.push(name)
      if (name === "# prepare-document") revoked = true
      return success()
    })
    const document = { requestedPath: "/fixture/opencode.jsonc", writePath: "/fixture/opencode.jsonc",
      exists: false, mode: 0o600, text: "{}\n", byteOrderMark: false, plugins: [] }
    await assert.rejects(replacePluginControlDocument(document, appendPluginControlRule(document, "acme"), {
      assertCurrent: () => { checks++; if (revoked) throw new Error("revoked before commit dispatch") },
    }, fileSystem), (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "filesystem")
    assert.equal(checks, 2)
    assert.deepEqual(calls, ["# prepare-document", "# cleanup-document"])
  })

  it("classifies a failed dispatched WSL commit as uncertain without replay", async () => {
    const calls: string[] = []
    const fileSystem = createWslPluginControlDocumentFileSystem("fixture-only", async (_distro, script) => {
      const name = firstLine(script)
      calls.push(name)
      return name === "# commit-document"
        ? { status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: new Error("connection lost") }
        : success()
    })
    const admission = new NativeMutationAdmission({ revalidate: async () => {}, assertCurrent: () => {} })
    const document = { requestedPath: "/fixture/opencode.jsonc", writePath: "/fixture/opencode.jsonc",
      exists: false, mode: 0o600, text: "{}\n", byteOrderMark: false, plugins: [] }
    let dispatches = 0
    await assert.rejects(replacePluginControlDocument(document, appendPluginControlRule(document, "acme"), {
      assertCurrent: () => admission.assertCurrent(),
      onDispatch: () => { admission.admit(); dispatches++ },
    }, fileSystem).catch((error) => { throw admission.failure(error) }), NativeMutationUncertainError)
    assert.equal(dispatches, 1)
    assert.deepEqual(calls, ["# prepare-document", "# commit-document", "# cleanup-document"])
  })

  it("refuses revoked authority after real WSL preparation without dispatch or leaked files", { skip: !distro }, async () => {
    const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
    const target = `${root}/opencode.jsonc`
    try {
      runWsl(distro!, `mkdir -m 700 -- "$1" && printf '%s\\n' '{ "plugins": [] }' > "$2" && chmod 600 -- "$2"`, root, target)
      const original = runWsl(distro!, `base64 -- "$1"`, target)
      const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
      const document = await readPluginControlDocument(target, fileSystem)
      assert.equal(document.mode, 0o600)
      const revokedError = new Error("authority revoked after preparation")
      let revoked = false, checks = 0, dispatches = 0
      const authority: NativeMutationAuthority = {
        revalidate: async () => {},
        assertCurrent: () => { checks++; if (revoked) throw revokedError },
      }

      await assert.rejects(replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), {
        assertCurrent: () => authority.assertCurrent(),
        beforeCommit: () => {
          runWsl(distro!, `test -d "$1.codenomad-plugin-controls.lock" && test "$(find "$2" -maxdepth 1 -name '*.tmp' | wc -l)" = 1`, target, root)
          revoked = true
        },
        onDispatch: () => { dispatches++ },
      }, fileSystem), (error: unknown) => (
        error instanceof PluginControlDocumentError && error.kind === "filesystem" && error.cause === revokedError
      ))

      assert.equal(revoked, true, "revocation occurs with a real prepared temporary file and held lock")
      assert.equal(checks, 2, "admission and final commit dispatch each check the same authority")
      assert.equal(dispatches, 0)
      assert.equal(runWsl(distro!, `base64 -- "$1"`, target), original)
      assert.equal(runWsl(distro!, `stat -c '%a' -- "$1"`, target).trim(), "600")
      assert.equal(runWsl(distro!, `ls -A -- "$1"`, root), "opencode.jsonc\n")
    } finally {
      runWsl(distro!, `rm -rf -- "$1"`, root)
    }
  })

  it("binds confirmed removal to native WSL mode and retains the freshly confirmed mode", { skip: !distro }, async () => {
    const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
    const global = `${root}/global`, project = `${root}/project`, target = `${global}/opencode.jsonc`
    try {
      runWsl(distro!, `mkdir -m 700 -- "$1" && mkdir -- "$2" "$3" && printf '%s\\n' '{ "plugins": ["fixture-plugin", "-kept.id"] }' > "$4" && chmod 600 -- "$4"`, root, global, project, target)
      const connection: any = { assertCurrent() {}, client: {
        config: { get: async () => [{ type: "directory", path: global }, { type: "document", path: target, info: JSON.parse(runWsl(distro!, `cat -- "$1"`, target)) }] },
        plugin: { list: async () => ({ data: [] }) },
      } }
      const controls = new PluginControls({ workspaceManager: {
        get: () => ({}), getSharedServiceConnection: async () => connection,
        getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? project : undefined,
        ownsLocation: async () => true, getWorktreeIdentityForPath: async () => "fixture",
        getServicePathStyle: () => "posix", getServiceWslDistro: () => distro,
        getHostPathForServicePath: async () => { throw new Error("WSL uses its native filesystem") },
      } as any, worktreeDeletionFence: { enter: () => () => {} }, logger: { info() {} } as any })
      const location = { directory: project }
      const revision = async () => (await controls.read("w", location)).targets.find(target => target.scope === "global")!.expectedRevision!
      const sources = new PluginSources({ documents: controls, logger: { info() {} } as any })
      const request = { location, scope: "global" as const, target: "fixture-plugin", entryIndex: 0, expectedRevision: await revision() }
      runWsl(distro!, `chmod 640 -- "$1"`, target)
      await assert.rejects(sources.remove("w", request), (error: any) => error.code === "stale")
      assert.deepEqual(JSON.parse(runWsl(distro!, `cat -- "$1"`, target)).plugins, ["fixture-plugin", "-kept.id"])
      await sources.remove("w", { ...request, expectedRevision: await revision() })
      assert.deepEqual(JSON.parse(runWsl(distro!, `cat -- "$1"`, target)).plugins, ["-kept.id"])
      assert.equal(runWsl(distro!, `stat -c '%a' -- "$1"`, target).trim(), "640")
    } finally { runWsl(distro!, `rm -rf -- "$1"`, root) }
  })

  it("preserves a native 0600 mode through one authorized real WSL dispatch", { skip: !distro }, async () => {
    const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
    const target = `${root}/opencode.jsonc`
    try {
      runWsl(distro!, `mkdir -m 700 -- "$1" && printf '%s\\n' '{ "plugins": [] }' > "$2" && chmod 600 -- "$2"`, root, target)
      const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
      const document = await readPluginControlDocument(target, fileSystem)
      assert.equal(document.mode, 0o600)

      let checks = 0, dispatches = 0
      await replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), {
        assertCurrent: () => { checks++ },
        onDispatch: () => { dispatches++ },
      }, fileSystem)

      assert.equal(checks, 2)
      assert.equal(dispatches, 1)
      assert.equal(runWsl(distro!, `stat -c '%a' -- "$1"`, target).trim(), "600")
      assert.match(runWsl(distro!, `cat -- "$1"`, target), /"-acme"/)
      assert.equal(runWsl(distro!, `ls -A -- "$1"`, root), "opencode.jsonc\n")
    } finally {
      runWsl(distro!, `rm -rf -- "$1"`, root)
    }
  })

  it("adds and removes plugin sources through the same WSL replacement, keeping 0600", { skip: !distro }, async () => {
    const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
    const target = `${root}/opencode.jsonc`
    try {
      runWsl(distro!, `mkdir -m 700 -- "$1" && printf '%s\\n' '{ // keep' '"plugins": [{ "package": "obj", "options": {} }, "-obj.id"] }' > "$2" && chmod 600 -- "$2"`, root, target)
      const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
      let document = await readPluginControlDocument(target, fileSystem)
      await replacePluginControlDocument(document, appendPluginControlRule(document, "fixture-plugin@1"), undefined, fileSystem)
      document = await readPluginControlDocument(target, fileSystem)
      assert.deepEqual(document.plugins, [{ package: "obj", options: {} }, "-obj.id", "fixture-plugin@1"])
      await replacePluginControlDocument(document, removePluginSourceEntry(document, 0, "obj"), undefined, fileSystem)
      document = await readPluginControlDocument(target, fileSystem)
      assert.deepEqual(document.plugins, ["-obj.id", "fixture-plugin@1"])
      assert.match(document.text, /\/\/ keep/)
      assert.equal(runWsl(distro!, `stat -c '%a' -- "$1"`, target).trim(), "600")
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
