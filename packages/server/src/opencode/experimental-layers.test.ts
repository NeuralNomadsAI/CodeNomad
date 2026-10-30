import assert from "node:assert/strict"
import test from "node:test"
import { projectMaskedBy } from "./experimental-layers"

const globalDirectory = "/home/me/.config/opencode", globalFile = `${globalDirectory}/opencode.jsonc`
const location = "/work/repo"
const target = `${location}/.opencode/opencode.jsonc`
const document = (path: string | undefined, experimental?: Record<string, unknown>) =>
  ({ type: "document", ...(path === undefined ? {} : { path }), info: experimental ? { experimental } : {} })
const directory = (path: string) => ({ type: "directory", path })
const fresh = (text: string, exists = true) =>
  ({ path: globalFile, document: { requestedPath: globalFile, writePath: globalFile, exists, mode: undefined, byteOrderMark: false, text } as any })

test("a missing project target sits after the project walk, below content and managed documents", () => {
  const entries = [
    document(undefined, { media_blob: false }), // integration
    document(globalFile, { media_blob: true }), directory(globalDirectory),
    document("/work/opencode.json", { todo: true }), // ancestor file
    document("/work/.opencode/opencode.json"), directory("/work/.opencode"),
    document(`${location}/.opencode/agents/design.md`),
    document(undefined, { media_blob: false }), // OPENCODE_CONFIG_CONTENT
    document("/etc/opencode/opencode.json", { media_blob: false }), directory("/etc/opencode"), // managed
  ]
  assert.equal(projectMaskedBy(entries, target, fresh('{"experimental":{"media_blob":true}}'))?.path, "/work/opencode.json")
  const withoutAncestor = entries.filter(entry => entry.path !== "/work/opencode.json")
  assert.equal(projectMaskedBy(withoutAncestor, target, fresh('{"experimental":{"media_blob":true}}'))?.path, globalFile)
  // An unrecognized layer (here an explicit config file) ends the walk instead of counting as lower.
  const explicit = [...withoutAncestor.slice(0, 3), document("/elsewhere/custom.json", { media_blob: false }), ...withoutAncestor.slice(3)]
  assert.equal(projectMaskedBy(explicit, target, fresh('{"experimental":{"media_blob":true}}'))?.path, globalFile)
  // Without a Global anchor nothing is assumed to be lower.
  assert.equal(projectMaskedBy(entries, target, undefined), undefined)
  // A listed target or directory keeps its native position.
  const listed = [...entries.slice(0, 5), document(target, { subagent_depth: 1 }), ...entries.slice(5)]
  assert.equal(projectMaskedBy(listed, target, fresh('{"experimental":{"media_blob":true}}'))?.path, "/work/opencode.json")
})

test("the fresh Global document replaces its lagging native entry", () => {
  const entries = [document(globalFile, { media_blob: false }), directory(globalDirectory)]
  assert.equal(projectMaskedBy(entries, target, fresh('{"experimental":{"media_blob":true}}'))?.info?.experimental?.media_blob, true)
  const enabled = [document(globalFile, { media_blob: true }), directory(globalDirectory)]
  assert.equal(projectMaskedBy(enabled, target, fresh('{"experimental":{"media_blob":false}}'))?.info?.experimental?.media_blob, false)
  assert.equal(projectMaskedBy(enabled, target, fresh("{}")), undefined, "a removed Global object hides nothing")
  // A Global document created after the native read sits before its directory.
  assert.equal(projectMaskedBy([directory(globalDirectory)], target, fresh('{"experimental":{"media_blob":true}}'))?.path, globalFile)
  assert.equal(projectMaskedBy([directory(globalDirectory)], target, fresh("", false)), undefined)
  // An unreadable fresh document keeps the native entry.
  assert.equal(projectMaskedBy(enabled, target, fresh('{"experimental":{},"experimental":{}}'))?.info?.experimental?.media_blob, true)
})
