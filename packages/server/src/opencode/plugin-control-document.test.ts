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
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-plugin-controls-"))
  temporaryDirectories.add(directory)
  return directory
}

function temporaryFile(): string {
  return path.join(temporaryDirectory(), "opencode.jsonc")
}
