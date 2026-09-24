import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { parse } from "jsonc-parser"
import {
  appendPluginControlRule,
  PluginControlDocumentError,
  readPluginControlDocument,
  replacePluginControlDocument,
} from "./plugin-control-document"

const temporaryDirectories = new Set<string>()

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe("plugin control JSONC document", () => {
  it("appends an ordered rule without replacing comments, sources, options, or unrelated keys", async () => {
    const target = temporaryFile()
    const original = `{
  // retained top-level comment
  "plugins": [
    {
      "package": "@acme/reviewer",
      "options": { "strict": true, "agent": "reviewer" },
      "futureKey": { "retained": true }
    }, // retained source comment
    "-opencode.provider.*",
  ],
  "experimental": { "custom": true },
}
`
    fs.writeFileSync(target, original)

    const document = await readPluginControlDocument(target)
    const updated = appendPluginControlRule(document, "opencode.provider.openai")
    await replacePluginControlDocument(document, updated)

    const written = fs.readFileSync(target, "utf8")
    assert.match(written, /retained top-level comment/)
    assert.match(written, /retained source comment/)
    assert.match(written, /"options": \{ "strict": true, "agent": "reviewer" \}/)
    assert.match(written, /"futureKey": \{ "retained": true \}/)
    assert.match(written, /"experimental": \{ "custom": true \}/)
    assert.deepEqual((parse(written) as any).plugins, [
      { package: "@acme/reviewer", options: { strict: true, agent: "reviewer" }, futureKey: { retained: true } },
      "-opencode.provider.*",
      "opencode.provider.openai",
    ])
  })

  it("creates a minimal JSONC document for a missing target", async () => {
    const target = path.join(temporaryDirectory(), "nested", "opencode.jsonc")
    const document = await readPluginControlDocument(target)
    assert.equal(document.exists, false)

    await replacePluginControlDocument(document, appendPluginControlRule(document, "-acme.reviewer"))

    assert.deepEqual(parse(fs.readFileSync(target, "utf8")), { plugins: ["-acme.reviewer"] })
  })

  it("retains a UTF-8 BOM, CRLF endings, and tab indentation", async () => {
    const target = temporaryFile()
    const original = `\uFEFF{\r\n\t"plugins": [\r\n\t\t"acme",\r\n\t],\r\n}\r\n`
    fs.writeFileSync(target, original, "utf8")

    const document = await readPluginControlDocument(target)
    await replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"))

    const written = fs.readFileSync(target)
    assert.deepEqual([...written.subarray(0, 3)], [0xef, 0xbb, 0xbf])
    const text = written.toString("utf8")
    assert.equal(text.replaceAll("\r\n", "").includes("\n"), false)
    assert.match(text, /\r\n\t\t"-acme"/)
    assert.deepEqual((parse(text.slice(1)) as any).plugins, ["acme", "-acme"])
  })

  it("never reads a configuration document beyond the 4 MiB limit", async () => {
    const target = temporaryFile()
    fs.writeFileSync(target, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20))

    await assert.rejects(readPluginControlDocument(target), (error: unknown) => (
      error instanceof PluginControlDocumentError && error.kind === "invalid"
    ))
  })

  it("fails closed for malformed JSONC, duplicate plugin keys, and malformed plugin options", async () => {
    for (const contents of [
      `{ "plugins": ["acme", } broken }`,
      `{ "plugins": ["acme"], "plugins": ["other"] }`,
      `{ "plugins": [{ "package": "acme", "options": true }] }`,
    ]) {
      const target = temporaryFile()
      fs.writeFileSync(target, contents)
      await assert.rejects(readPluginControlDocument(target), (error: unknown) => (
        error instanceof PluginControlDocumentError && error.kind === "invalid"
      ))
      assert.equal(fs.readFileSync(target, "utf8"), contents)
    }
  })

  it("keeps an external replacement intact when the source changes before commit", async () => {
    const target = temporaryFile()
    fs.writeFileSync(target, `{ "plugins": ["acme"] }\n`)
    const document = await readPluginControlDocument(target)
    const updated = appendPluginControlRule(document, "-acme")
    fs.writeFileSync(target, `{ "plugins": ["external"] }\n`)

    await assert.rejects(replacePluginControlDocument(document, updated), (error: unknown) => (
      error instanceof PluginControlDocumentError && error.kind === "conflict"
    ))
    assert.equal(fs.readFileSync(target, "utf8"), `{ "plugins": ["external"] }\n`)
    assert.equal(fs.readdirSync(path.dirname(target)).some((entry) => entry.endsWith(".tmp")), false)
  })

  it("rechecks authorization at the atomic commit point", async () => {
    const target = temporaryFile()
    const original = `{ "plugins": ["acme"] }\n`
    fs.writeFileSync(target, original)
    const document = await readPluginControlDocument(target)
    let checked = false

    await assert.rejects(
      replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), {
        beforeCommit: () => {
          checked = true
          throw new Error("stale connection")
        },
      }),
      (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "filesystem",
    )

    assert.equal(checked, true)
    assert.equal(fs.readFileSync(target, "utf8"), original)
    assert.equal(fs.readdirSync(path.dirname(target)).some((entry) => entry.endsWith(".tmp")), false)
    assert.equal(fs.readdirSync(path.dirname(target)).some((entry) => entry.includes("codenomad-plugin-controls.lock")), false)
  })

  it("rejects an external write made after the first conflict check", async () => {
    const target = temporaryFile()
    const original = `{ "plugins": ["acme"] }\n`
    const external = `{ "plugins": ["external"] }\n`
    fs.writeFileSync(target, original)
    const document = await readPluginControlDocument(target)

    await assert.rejects(
      replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), {
        beforeCommit: () => fs.writeFileSync(target, external),
      }),
      (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict",
    )

    assert.equal(fs.readFileSync(target, "utf8"), external)
    assert.equal(fs.readdirSync(path.dirname(target)).some((entry) => entry.includes("codenomad-plugin-controls.lock")), false)
  })

  it("maps a directory swap before the atomic rename to a conflict", async () => {
    const target = temporaryFile()
    fs.writeFileSync(target, `{ "plugins": [] }\n`)
    const document = await readPluginControlDocument(target)

    await assert.rejects(
      replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"), {
        beforeCommit: () => {
          fs.rmSync(target, { force: true })
          fs.mkdirSync(target)
        },
      }),
      (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict",
    )
    assert.ok(fs.statSync(target).isDirectory())
    fs.rmSync(target, { recursive: true, force: true })
  })

  it("serializes competing backend replacements with a per-target lock", async () => {
    const target = temporaryFile()
    fs.writeFileSync(target, `{ "plugins": [] }\n`)
    const [first, second] = await Promise.all([
      readPluginControlDocument(target),
      readPluginControlDocument(target),
    ])

    const results = await Promise.allSettled([
      replacePluginControlDocument(first, appendPluginControlRule(first, "first")),
      replacePluginControlDocument(second, appendPluginControlRule(second, "second")),
    ])

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    assert.ok(rejected?.reason instanceof PluginControlDocumentError)
    assert.equal(rejected.reason.kind, "conflict")
    const plugins = (parse(fs.readFileSync(target, "utf8")) as any).plugins
    assert.ok(Array.isArray(plugins) && plugins.length === 1 && ["first", "second"].includes(plugins[0]))
  })

  it("does not delete a successor lock when a stalled owner releases", async () => {
    const target = temporaryFile()
    const original = `{ "plugins": [] }\n`
    fs.writeFileSync(target, original)
    const document = await readPluginControlDocument(target)
    const lockPath = `${document.writePath}.codenomad-plugin-controls.lock`
    const ownerPath = `${lockPath}/owner`

    await assert.rejects(
      replacePluginControlDocument(document, appendPluginControlRule(document, "first"), {
        beforeCommit: () => {
          // Simulate a stalled first owner whose lease expired: a successor
          // reaps the stale directory and owns it with a different nonce.
          fs.rmSync(lockPath, { recursive: true, force: true })
          fs.mkdirSync(lockPath, { mode: 0o700 })
          fs.writeFileSync(ownerPath, "successor-nonce", { mode: 0o600 })
        },
      }),
      (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict",
    )

    assert.equal(fs.readFileSync(target, "utf8"), original)
    assert.equal(fs.readFileSync(ownerPath, "utf8"), "successor-nonce")
    fs.rmSync(lockPath, { recursive: true, force: true })
  })

  it("retains the source mode when the process umask is restrictive", async () => {
    const target = temporaryFile()
    fs.writeFileSync(target, `{ "plugins": [] }\n`)
    await fs.promises.chmod(target, 0o644).catch(() => undefined)
    const previousUmask = process.umask(0o077)
    try {
      const document = await readPluginControlDocument(target)
      await replacePluginControlDocument(document, appendPluginControlRule(document, "-acme"))
      assert.equal(fs.statSync(target).mode & 0o777, document.mode)
      if (process.platform !== "win32") assert.equal(document.mode, 0o644)
    } finally {
      process.umask(previousUmask)
    }
  })

  it("rejects a mode-only external change as a conflict", async function () {
    if (process.platform === "win32") return
    const target = temporaryFile()
    fs.writeFileSync(target, `{ "plugins": [] }\n`)
    await fs.promises.chmod(target, 0o600)
    const document = await readPluginControlDocument(target)
    await fs.promises.chmod(target, 0o644)

    await assert.rejects(
      replacePluginControlDocument(document, appendPluginControlRule(document, "-acme")),
      (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict",
    )
    assert.equal(fs.statSync(target).mode & 0o777, 0o644)
  })

  it("reports a deep missing path as missing instead of a symlink error", async () => {
    const root = temporaryDirectory()
    const deep = Array.from({ length: 20 }, (_, index) => `level-${index}`).join(path.sep)
    const target = path.join(root, deep, "opencode.jsonc")
    const document = await readPluginControlDocument(target)
    assert.equal(document.exists, false)
  })
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-plugin-controls-"))
  temporaryDirectories.add(directory)
  return directory
}

function temporaryFile(): string {
  return path.join(temporaryDirectory(), "opencode.jsonc")
}
