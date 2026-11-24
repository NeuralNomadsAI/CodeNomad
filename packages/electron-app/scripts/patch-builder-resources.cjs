const { createHash } = require("node:crypto")
const { readFileSync, writeFileSync } = require("node:fs")
const { createRequire } = require("node:module")

// Pin the reviewed upstream editor: resource edits must finish before signIf().
const upstreamHash = "02ddb3dee119c3f8aaf6a427e7fea8b2765a61778e5db6f5e02df1cbb5b16cde"
const replacements = [
  ['vi.setFileVersion(opts.fileVersion);', 'vi.setFileVersion(opts.fileVersion.replace(/[-+].*$/, ""), lang.lang);'],
  ['vi.setProductVersion(opts.productVersion);', 'vi.setProductVersion(opts.productVersion.replace(/[-+].*$/, ""), lang.lang);'],
  ['{ FileVersion: opts.fileVersion }', '{ FileVersion: opts.fileVersion, ProductVersion: opts.productVersion }'],
]
const hash = (source) => createHash("sha256").update(source).digest("hex")

function patchSource(source) {
  const original = replacements.reduce((text, [before, after]) => text.replace(after, before), source)
  if (hash(original) !== upstreamHash) throw new Error("Unreviewed electron-builder Windows resource editor")
  return replacements.reduce((text, [before, after]) => text.replace(before, after), original)
}

function patchBuilderResources() {
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"))
  const { version } = builderRequire("app-builder-lib/package.json")
  if (version !== "26.18.0") throw new Error(`Unreviewed app-builder-lib ${version}`)
  const file = builderRequire.resolve("app-builder-lib/out/util/resEdit.js")
  const source = readFileSync(file, "utf8")
  const patched = patchSource(source)
  if (source !== patched) writeFileSync(file, patched)
}

module.exports = { patchSource, patchBuilderResources }
if (require.main === module) patchBuilderResources()
