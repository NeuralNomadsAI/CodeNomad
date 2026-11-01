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
import { PluginControls } from "./plugin-controls"
import { PluginSources } from "./plugin-sources"

describe("WSL plugin control documents", () => {
  it("keeps native paths and source permissions in WSL operations", async () => {
    const calls: Array<{ script: string; args: readonly string[]; input?: Buffer }> = []
    const execute: WslPluginControlExecutor = async (distro, script, args, input) => {
      assert.equal(distro, "Ubuntu")
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
    assert.equal(prepare?.args[11], document.requestedPath)
    assert.match(prepare?.args[8] ?? "", /^[a-f0-9]{64}$/)
    assert.match(prepare?.args[4] ?? "", /^[a-f0-9]{32}$/)
    const commit = calls.find((call) => call.script === "# commit-document")
    assert.equal(commit?.args[0], "/home/dev/.config/opencode/opencode.jsonc")
    assert.equal(commit?.args[6], "600")
    assert.equal(commit?.args[7], "600")
    assert.equal(commit?.args[8], document.requestedPath)
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

    assert.equal(cleanups.length, 1, "replace disposes its prepared write after commit")
    assert.equal(cleanups[0]?.[1], prepares[0]?.[3])
    assert.equal(cleanups[0]?.[2], prepares[0]?.[4])
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

  it("rejects a non-native requested alias before preparing any file", async () => {
    const fileSystem = createWslPluginControlDocumentFileSystem("Ubuntu", async (_distro, script) => {
      assert.equal(firstLine(script), "# read-document", "invalid requested paths must never reach prepare")
      return success(Buffer.from("file\0/project/opencode.jsonc\0" + "600\0{}\n"))
    })
    const document = await readPluginControlDocument("/project/opencode.jsonc", fileSystem)
    for (const requestedPath of ["relative/opencode.jsonc", "C:\\project\\opencode.jsonc", "//wsl/Ubuntu/config"]) {
      await assert.rejects(fileSystem.prepare({ ...document, requestedPath }, "{}\n"), /Invalid native WSL configuration path/)
    }
  })

  it("prepares without renaming, verifies under the same nonce and fences deferred commits", async () => {
    const calls: Array<{ script: string; args: readonly string[] }> = []
    let authorized = true
    let fences = 0
    const execute: WslPluginControlExecutor = async (distro, script, args) => {
      assert.equal(distro, "Ubuntu")
      calls.push({ script: firstLine(script), args })
      if (firstLine(script) === "# read-document") {
        return success(Buffer.from(`file\0${args[0]}\0` + "600\0{}\n"))
      }
      return success()
    }
    const fileSystem = createWslPluginControlDocumentFileSystem("Ubuntu", execute)
    const document = await readPluginControlDocument("/project/opencode.jsonc", fileSystem)
    const prepared = await fileSystem.prepare(document, "{\"experimental\":{\"schedules\":true}}\n", {
      beforeCommit: () => { fences++; if (!authorized) throw new Error("stale connection") },
    })
    assert.equal(fences, 0)
    assert.equal(calls.some(call => call.script === "# commit-document"), false)
    await prepared.verify()
    assert.equal(fences, 0, "verify is read-only; the connection fence runs at commit")
    const lock = calls.find(call => call.script === "# prepare-document")!.args
    const verify = calls.find(call => call.script === "# verify-document")!.args
    assert.equal(verify[4], lock[3])
    assert.equal(verify[5], lock[4])
    authorized = false
    await assert.rejects(prepared.commit(), (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "filesystem")
    assert.equal(fences, 1)
    assert.equal(calls.some(call => call.script === "# commit-document"), false)
    await prepared.dispose()
    await prepared.dispose()
    assert.equal(calls.filter(call => call.script === "# cleanup-document").length, 1)
    await assert.rejects(prepared.verify(), /no longer active/)
    await assert.rejects(prepared.commit(), /no longer active/)
  })

  it("maps source and nonce verification failures to conflicts while retaining cleanup ownership", async () => {
    for (const status of [73, 75]) {
      const calls: Array<{ script: string; args: readonly string[] }> = []
      const execute: WslPluginControlExecutor = async (_distro, script, args) => {
        calls.push({ script: firstLine(script), args })
        if (firstLine(script) === "# read-document") return success(Buffer.from(`file\0${args[0]}\0` + "600\0{}\n"))
        return firstLine(script) === "# verify-document" ? { ...success(), status } : success()
      }
      const fileSystem = createWslPluginControlDocumentFileSystem("Ubuntu", execute)
      const document = await readPluginControlDocument("/project/opencode.jsonc", fileSystem)
      const prepared = await fileSystem.prepare(document, "{}\n")
      try {
        await assert.rejects(prepared.verify(), (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict")
        assert.equal(calls.some(call => call.script === "# commit-document"), false)
      } finally { await prepared.dispose() }
      const lock = calls.find(call => call.script === "# prepare-document")!.args
      const cleanup = calls.find(call => call.script === "# cleanup-document")!.args
      assert.deepEqual(cleanup, [lock[2], lock[3], lock[4]])
    }
  })

  const distro = process.env.CODENOMAD_TEST_WSL_PLUGIN_CONTROLS
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

  for (const phase of ["before prepare", "after prepare", "at commit"] as const) {
    it(`refuses a native WSL requested symlink retarget ${phase} with identical target bytes and modes`, { skip: !distro }, async () => {
      const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
      const original = `${root}/original.jsonc`, replacement = `${root}/replacement.jsonc`, alias = `${root}/opencode.jsonc`
      const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
      let prepared: Awaited<ReturnType<typeof fileSystem.prepare>> | undefined
      const retarget = () => { runWsl(distro!, `ln -sfn replacement.jsonc "$1"`, alias) }
      try {
        runWsl(distro!, `mkdir -m 700 "$1"; printf '{}\n' > "$2"; printf '{}\n' > "$3"; chmod 600 "$2" "$3"; ln -s original.jsonc "$4"`, root, original, replacement, alias)
        const document = await readPluginControlDocument(alias, fileSystem)
        assert.equal(document.requestedPath, alias)
        assert.equal(document.writePath, original)
        if (phase === "before prepare") {
          retarget()
          await assert.rejects(fileSystem.prepare(document, '{"changed":true}\n'),
            (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict")
        } else {
          prepared = await fileSystem.prepare(document, '{"changed":true}\n', phase === "at commit" ? { beforeCommit: retarget } : undefined)
          if (phase === "after prepare") {
            retarget()
            await assert.rejects(prepared.verify(), (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict")
          } else await prepared.verify()
          await assert.rejects(prepared.commit(), (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict")
        }
        assert.equal(runWsl(distro!, `cat "$1" "$2"`, original, replacement), "{}\n{}\n", "neither physical target may change")
      } finally {
        try {
          await prepared?.dispose()
          assert.equal(runWsl(distro!, `find "$1" -name '*.tmp' -o -name '*.lock'`, root), "")
        } finally { runWsl(distro!, `rm -rf -- "$1"`, root) }
      }
    })
  }

  it("preflights both native WSL documents and keeps both locks through atomic commits", { skip: !distro }, async () => {
    const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
    const targets = [`${root}/global.jsonc`, `${root}/project.jsonc`]
    const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
    const prepared: Awaited<ReturnType<typeof fileSystem.prepare>>[] = []
    try {
      runWsl(distro!, `mkdir -m 700 -- "$1"; printf '{}\n' > "$2"; printf '{}\n' > "$3"; chmod 600 "$2"; chmod 640 "$3"`, root, ...targets)
      for (const target of targets) {
        prepared.push(await fileSystem.prepare(await readPluginControlDocument(target, fileSystem), '{"experimental":{"schedules":true}}\n'))
      }
      for (const target of targets) {
        assert.equal(runWsl(distro!, `cat "$1"; test -s "$1.codenomad-plugin-controls.lock/owner"`, target), "{}\n")
      }
      for (const write of prepared) await write.verify()
      for (const write of prepared) await write.commit()
      for (const [index, target] of targets.entries()) {
        assert.match(runWsl(distro!, `cat "$1"`, target), /"schedules":true/)
        assert.equal(runWsl(distro!, `stat -c '%a' "$1"; test -s "$1.codenomad-plugin-controls.lock/owner"`, target).trim(), index ? "640" : "600")
      }
    } finally {
      for (const write of prepared) await write.dispose()
      assert.equal(runWsl(distro!, `find "$1" -name '*.tmp' -o -name '*.lock'`, root), "")
      runWsl(distro!, `rm -rf -- "$1"`, root)
    }
  })

  for (const readOnly of ["file", "parent"] as const) {
    it(`refuses a read-only WSL project ${readOnly} during prepare before the global rename`, { skip: !distro }, async () => {
      const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
      const global = `${root}/global.jsonc`, project = `${root}/project/opencode.jsonc`
      const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
      let prepared: Awaited<ReturnType<typeof fileSystem.prepare>> | undefined
      try {
        runWsl(distro!, `mkdir -m 700 -- "$1" "$1/project"; printf '{}\n' > "$2"; printf '{}\n' > "$3"; chmod 600 "$2" "$3"`, root, global, project)
        runWsl(distro!, readOnly === "file" ? `chmod 400 "$1"` : `chmod 500 "$1/project"`, readOnly === "file" ? project : root)
        prepared = await fileSystem.prepare(await readPluginControlDocument(global, fileSystem), '{"experimental":{"schedules":true}}\n')
        await assert.rejects(fileSystem.prepare(await readPluginControlDocument(project, fileSystem), '{"experimental":{"schedules":true}}\n'),
          (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "filesystem")
        assert.equal(runWsl(distro!, `cat "$1" "$2"`, global, project), "{}\n{}\n", "neither config was renamed")
      } finally {
        await prepared?.dispose()
        runWsl(distro!, `chmod 700 "$1/project"`, root)
        assert.equal(runWsl(distro!, `find "$1" -name '*.tmp' -o -name '*.lock'`, root), "")
        runWsl(distro!, `rm -rf -- "$1"`, root)
      }
    })
  }

  for (const change of ["bytes", "mode", "nonce"] as const) {
    it(`rechecks native WSL ${change} after prepare and preserves a successor's lock`, { skip: !distro }, async () => {
      const root = `/tmp/codenomad-plugin-controls-${randomBytes(8).toString("hex")}`
      const target = `${root}/opencode.jsonc`
      const fileSystem = createWslPluginControlDocumentFileSystem(distro!)
      let prepared: Awaited<ReturnType<typeof fileSystem.prepare>> | undefined
      try {
        runWsl(distro!, `mkdir -m 700 "$1"; printf '{}\n' > "$2"; chmod 600 "$2"`, root, target)
        prepared = await fileSystem.prepare(await readPluginControlDocument(target, fileSystem), '{"changed":true}\n')
        runWsl(distro!, change === "bytes" ? `printf '{"external":true}\n' > "$1"`
          : change === "mode" ? `chmod 640 "$1"` : `printf successor > "$1.codenomad-plugin-controls.lock/owner"`, target)
        for (const operation of [prepared.verify, prepared.commit]) {
          await assert.rejects(operation(), (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict")
        }
        assert.doesNotMatch(runWsl(distro!, `cat "$1"`, target), /"changed"/)
        await prepared.dispose()
        if (change === "nonce") assert.equal(runWsl(distro!, `cat "$1.codenomad-plugin-controls.lock/owner"`, target), "successor")
        assert.equal(runWsl(distro!, `find "$1" -name '*.tmp'`, root), "")
      } finally {
        await prepared?.dispose()
        runWsl(distro!, `rm -rf -- "$1"`, root)
      }
    })
  }

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
