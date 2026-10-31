import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parse } from "jsonc-parser"
import { appendPluginControlRule, type PluginControlDocument, type PluginConfigEntry } from "./plugin-control-document"
import {
  pluginPackageIdentities,
  PluginSourceSpecError,
  removePluginSourceEntry,
  validatePluginSourceSpec,
} from "./plugin-source-document"
import { PluginControlDocumentError } from "./plugin-control-document"

function documentFor(text: string, plugins: PluginConfigEntry[], byteOrderMark = false): PluginControlDocument {
  return { requestedPath: "/x/opencode.jsonc", writePath: "/x/opencode.jsonc", exists: true, mode: 0o644, text, byteOrderMark, plugins }
}

describe("plugin source specs", () => {
  it("accepts registry, alias and remote Git specs exactly as OpenCode's plugin add does", () => {
    for (const spec of ["foo", "@scope/pkg", "@scope/pkg@^1.2.0", "foo@latest", "foo@1.2.3", "bar@npm:foo@1",
      "github:user/repo", "user/repo#v1", "git+https://github.com/user/repo.git#v1", "git+ssh://git@example.com/x.git"]) {
      assert.doesNotThrow(() => validatePluginSourceSpec(spec), spec)
    }
  })

  it("refuses local paths, tarballs, variables, selectors and control characters before any write", () => {
    const cases: Array<[string, string]> = [
      ["./plugin", "local-path"], ["../plugin", "local-path"], ["/abs/plugin", "local-path"], ["~/plugin", "local-path"],
      ["C:\\plugin", "local-path"], ["file:../plugin", "local-path"], ["git+file:///tmp/repo", "local-path"],
      ["https://example.com/plugin.tgz", "invalid-spec"], ["foo@{env:VERSION}", "invalid-spec"], ["{file:./spec}", "invalid-spec"],
      ["-foo", "plugin-id"], ["foo.*", "plugin-id"], ["*", "plugin-id"], ["opencode.builtin", "plugin-id"],
      ["foo\u0007", "invalid-spec"], [" foo", "invalid-spec"], ["a b", "invalid-spec"], ["", "invalid-spec"], ["x".repeat(513), "invalid-spec"],
    ]
    for (const [spec, code] of cases) {
      assert.throws(() => validatePluginSourceSpec(spec), (error: unknown) => error instanceof PluginSourceSpecError && error.code === code, spec)
    }
  })

  it("normalizes package identity across versions, ranges, tags, case, aliases and Git forms", () => {
    const same = (left: string, right: string) => pluginPackageIdentities(left).some(key => pluginPackageIdentities(right).includes(key))
    assert.ok(same("foo", "foo@1.2.3"))
    assert.ok(same("foo@^1", "foo@next"))
    assert.ok(same("Foo", "foo@2"))
    assert.ok(same("bar@npm:foo@1", "foo"), "an alias installs its target package")
    assert.ok(same("bar@npm:foo@1", "bar@3"), "and declares its alias name")
    assert.ok(same("github:user/repo", "git+https://github.com/user/repo.git#v2"))
    assert.ok(same("user/repo#main", "git+ssh://git@github.com/user/repo.git"))
    assert.ok(!same("foo", "foobar"))
    assert.ok(!same("@a/foo", "@b/foo"))
    assert.deepEqual(pluginPackageIdentities("./local"), [])
  })
})

describe("plugin source document edits", () => {
  it("appends a string source at the end, keeping comments, CRLF and the BOM", () => {
    const text = '{\r\n  // keep\r\n  "plugins": [\r\n    "-first",\r\n    { "package": "obj", "options": { "a": 1 } }\r\n  ]\r\n}\r\n'
    const updated = appendPluginControlRule(documentFor(text, ["-first", { package: "obj", options: { a: 1 } }], true), "@scope/new@1")
    assert.ok(updated.startsWith("\uFEFF"))
    assert.match(updated, /\/\/ keep/)
    assert.ok(!/[^\r]\n/.test(updated), "only CRLF line endings")
    assert.deepEqual(parse(updated.slice(1)).plugins, ["-first", { package: "obj", options: { a: 1 } }, "@scope/new@1"])
  })

  it("removes exactly the targeted string or object entry and nothing else", () => {
    const text = '\uFEFF{\r\n  "plugins": [\r\n    // first\r\n    "a@1",\r\n    { "package": "b", "options": { "x": true } }, // trailing\r\n    "-b.id",\r\n    "c"\r\n  ],\r\n  "shell": "keep"\r\n}\r\n'.slice(1)
    const plugins: PluginConfigEntry[] = ["a@1", { package: "b", options: { x: true } }, "-b.id", "c"]
    const object = removePluginSourceEntry(documentFor(text, plugins, true), 1, "b")
    assert.ok(object.startsWith("\uFEFF"))
    assert.match(object, /\/\/ first/)
    assert.ok(!/[^\r]\n/.test(object))
    assert.deepEqual(parse(object.slice(1)), { plugins: ["a@1", "-b.id", "c"], shell: "keep" }, "activation rules stay in place")
    const last = removePluginSourceEntry(documentFor(text, plugins), 3, "c")
    assert.deepEqual(parse(last).plugins, ["a@1", { package: "b", options: { x: true } }, "-b.id"])
    const only = removePluginSourceEntry(documentFor('{ "plugins": ["solo"] }', ["solo"]), 0, "solo")
    assert.deepEqual(parse(only), { plugins: [] })
    assert.ok(only.endsWith("\n"))
  })

  it("refuses a stale index or a changed entry as a conflict", () => {
    const document = documentFor('{ "plugins": ["a", "b"] }', ["a", "b"])
    for (const [index, target] of [[1, "a"], [2, "b"], [-1, "a"], [0.5, "a"]] as const) {
      assert.throws(() => removePluginSourceEntry(document, index, target),
        (error: unknown) => error instanceof PluginControlDocumentError && error.kind === "conflict", `${index}:${target}`)
    }
  })
})
