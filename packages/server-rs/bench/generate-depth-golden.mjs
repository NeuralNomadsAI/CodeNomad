// Golden outputs of the TS subagent-depth document editor (built dist, unchanged), read by the Rust unit
// tests (`depth-golden.json`) for byte-for-byte comparison.
//   node generate-depth-golden.mjs [output folder]   (default tests/fixtures)
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fromDist } from "./fixtures.mjs"

const out = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../tests/fixtures"))
const dist = name => fromDist(`opencode/${name}.js`)
const { readNativeSetting, removeEmptyNativeObject, withEditedText, editNativeSetting } = await dist("native-setting-document")
const { editMissionExperimental, inheritedMissionExperimental, nativeSettingExpectation } = await dist("native-experimental-settings")
const { withNestingRule, withoutNestingRule, nestingRuleSkipped, nestingEffect, nestingToolHidden } = await dist("subagent-nesting")
const { PluginControlDocumentError } = await dist("plugin-control-document")

// Verbatim copy of the module-private `withoutRedundantExperimental` (subagent-depth-settings.ts).
function withoutRedundantExperimental(document, inherited, removing) {
  return removeEmptyNativeObject(document, ["experimental"], value => {
    const properties = Object.keys(value).filter(key => key !== removing)
    return properties.length === 0
      || inherited !== undefined && properties.length === 1 && properties[0] === "media_blob" && value.media_blob === inherited
  })
}
// Verbatim body of the `update` edit callback, after the expectation check.
function editText(document, current, value, exposed) {
  const keys = ["experimental", "subagent_depth"]
  const cleaned = value === null ? withoutRedundantExperimental(document, exposed, keys[1]) : undefined
  const text = cleaned ?? editMissionExperimental(document, "subagent_depth", value ?? undefined,
    inheritedMissionExperimental(current.entries, current.path, current.location.directory))
  const edited = withEditedText(document, text)
  if (value === null) return withoutNestingRule(edited) ?? text
  return withNestingRule(edited) ?? text
}
const outcome = run => {
  try { return { text: run() } } catch (error) {
    if (error instanceof PluginControlDocumentError) return { error: { kind: error.kind, message: error.message } }
    return { error: { plain: true } }
  }
}

const G = "C:\\fx\\config", P = "C:\\fx\\project"
const target = `${P}\\.opencode\\opencode.jsonc`, direct = `${P}\\opencode.jsonc`
const entrySets = {
  projectDoc: [{ type: "document", path: `${G}\\opencode.jsonc`, info: { experimental: { automations: true } } }, { type: "directory", path: G },
    { type: "document", path: direct, info: { experimental: { media_blob: true } } }],
  none: [{ type: "directory", path: G }],
  globalDepth: [{ type: "document", path: `${G}\\opencode.jsonc`, info: { experimental: { subagent_depth: 2, media_blob: true } } }, { type: "directory", path: G }],
  automations: [{ type: "document", path: `${G}\\opencode.jsonc`, info: { experimental: { automations: true } } }, { type: "directory", path: G }],
  invalid: [{ type: "document", path: `${G}\\opencode.jsonc`, info: { experimental: { automations: "yes" } } }, { type: "directory", path: G }],
  unknown: [{ type: "document", info: {} }],
}
const documents = {
  absent: { text: "{}\n", exists: false, mode: 0o600 },
  empty: { text: "{}" },
  blank: { text: "{\n}\n" },
  comments: { text: `{\n  // top comment\n  "$schema": "https://opencode.ai/config.json", /* inline */\n  "model": "x/y" // trailing\n}\n` },
  media: { text: `{\n  "experimental": {\n    "media_blob": true\n  }\n}\n` },
  mediaFalse: { text: `{\n  "experimental": {\n    "media_blob": false\n  }\n}\n` },
  depthMedia: { text: `{\n  "experimental": {\n    // keep me\n    "subagent_depth": 4,\n    "media_blob": true\n  },\n  "model": "a/b"\n}\n` },
  depthOnly: { text: `{\n  "model": "a/b",\n  "experimental": { "subagent_depth": 1 }\n}\n` },
  depthComment: { text: `{\n  "experimental": {\n    "subagent_depth": 5 // why\n  }\n}\n` },
  native: { text: `{\n  "agents": {\n    "general": {\n      "permissions": [\n        { "action": "read", "resource": "*", "effect": "allow" }\n      ]\n    }\n  }\n}\n` },
  nativeEmpty: { text: `{\n  "agents": {\n    "general": {\n      "permissions": []\n    }\n  }\n}\n` },
  nativeTrailing: { text: `{\n  "agents": {\n    "general": {\n      "permissions": [\n        { "action": "read", "resource": "*", "effect": "allow" }, // read\n      ],\n    },\n  },\n}\n` },
  otherAgents: { text: `{\n  "agents": {\n    "build": { "mode": "primary" }\n  }\n}\n` },
  legacy: { text: `{\n  "agent": {\n    "general": {\n      "permission": { "edit": "allow" }\n    }\n  }\n}\n` },
  legacyTools: { text: `{\n  "mode": {\n    "general": {\n      "tools": { "subagent": true },\n      "permission": { "task": "deny" }\n    }\n  }\n}\n` },
  legacyString: { text: `{\n  "agent": {\n    "general": {\n      "permission": "allow"\n    }\n  }\n}\n` },
  legacyBare: { text: `{\n  "mode": {\n    "general": {}\n  }\n}\n` },
  tabs: { text: `{\n\t"model": "a/b",\n\t"experimental": {\n\t\t"media_blob": true\n\t}\n}\n` },
  crlf: { text: `{\r\n  "model": "a/b"\r\n}\r\n` },
  bom: { text: `{\n    "model": "a/b"\n}\n`, bom: true },
  compact: { text: `{"experimental":{"subagent_depth":2},"agents":{"general":{}}}` },
  deep: { text: `{\n        "model": "a/b"\n}\n` },
  automationsLocal: { text: `{\n  "experimental": {\n    "automations": false,\n    "subagent_depth": 3\n  }\n}\n` },
  duplicate: { text: `{\n  "experimental": { "subagent_depth": 1 },\n  "experimental": { "subagent_depth": 2 }\n}\n` },
  notObject: { text: `{\n  "experimental": true\n}\n` },
  badDepth: { text: `{\n  "experimental": { "subagent_depth": -1 }\n}\n` },
  unicode: { text: `{\n  "name": "Café ☕ \\ud83d\\ude00 😀",\n  "experimental": { "media_blob": true }\n}\n` },
}
const doc = ({ text, bom = false, exists = true, mode = 0o666 }) => ({
  requestedPath: target, writePath: target, exists, mode, text, byteOrderMark: bom, plugins: [],
})
const cases = []
for (const [name, spec] of Object.entries(documents)) {
  const document = doc(spec)
  const results = []
  for (const path of [target, direct]) for (const entries of Object.keys(entrySets)) for (const value of [3, 0, null]) for (const exposed of [undefined, true, false]) {
    if (entries !== "none" && exposed !== undefined) continue
    if (path === direct && !["projectDoc", "none"].includes(entries)) continue
    const current = { entries: entrySets[entries], path, location: { directory: P } }
    const first = outcome(() => editText(document, current, value, exposed))
    const result = { path, entries, value, exposed: exposed ?? null, out: first }
    if (first.text !== undefined && value !== null) {
      result.back = outcome(() => editText(withEditedText(document, first.text), current, null, exposed))
    }
    results.push(result)
  }
  const read = outcome(() => JSON.stringify(readNativeSetting(document, ["experimental", "subagent_depth"]) ?? null))
  cases.push({ name, document: { text: spec.text, bom: spec.bom ?? false, exists: spec.exists ?? true, mode: spec.mode ?? 0o666 },
    expectation: nativeSettingExpectation(document), read,
    skipped: nestingRuleSkipped(document),
    empty: [undefined, true, false].map(exposed => outcome(() => withoutRedundantExperimental(document, exposed) === undefined ? "" : "yes")),
    results })
}
// Direct JSONC edits with unusual layouts exercise jsonc-parser's formatter.
const layouts = ["{}", "{ }", `{ "a": 1 }`, `{\n  "a": 1,\n}`, `{\n      "x": { "y": [1, 2] } // c\n}`, `{\n\t\t"a": {\n\t\t\t"b": 1\n\t\t}\n}`,
  `{"a":{"b":{"c":1}}}`, `{\r\n  "a": 1\r\n}`, `{ /* c */ }`, `{\n  "a": 1 /* x */\n}`]
const edits = []
for (const text of layouts) for (const [keys, value] of [[["a"], 2], [["a", "b"], true], [["n", "m", "o"], { k: [1] }], [["a"], undefined], [["a", "b"], undefined]]) {
  edits.push({ text, keys, value: value ?? null, remove: value === undefined, out: outcome(() => editNativeSetting(doc({ text }), keys, value)) })
}
const ruleSets = [
  [{ action: "*", resource: "*", effect: "allow" }, { action: "subagent", resource: "*", effect: "deny" }],
  [{ action: "subagent", resource: "*", effect: "deny" }, { action: "subagent", resource: "general", effect: "allow" }],
  [{ action: "SUBAGENT", resource: "Gen*", effect: "ask" }],
  [{ action: "sub?gent", resource: "general *", effect: "allow" }],
  [{ action: "su*", resource: "g?neral", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }],
  [{ action: "subagent", resource: "*", effect: "weird" }],
  [null, { action: 3 }, { action: "subagent", resource: 5, effect: "allow" }],
]
const effects = ruleSets.flatMap(rules => [true, false].map(ignoreCase => ({ rules, ignoreCase,
  effect: nestingEffect(rules, ignoreCase) ?? null, hidden: nestingToolHidden(rules, ignoreCase) })))
await mkdir(out, { recursive: true })
await writeFile(path.join(out, "depth-golden.json"), JSON.stringify({ target, directory: P, entrySets, cases, edits, effects }, null, 1))
console.log(`golden: ${cases.length} documents, ${cases.reduce((n, c) => n + c.results.length, 0)} edits, ${edits.length} layouts, ${effects.length} rule sets`)
