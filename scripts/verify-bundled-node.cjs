const fs = require("fs")
const path = require("path")
const { NPM_VERSION } = require("./bundled-npm.cjs")
const { npmRelativePath } = require("./prepare-node-runtime.cjs")

const npmOnly = process.argv.includes("--npm-only")
const targets = process.argv.slice(2).filter(arg => arg !== "--npm-only")

if (targets.length === 0) {
  console.error("Usage: node scripts/verify-bundled-node.cjs [--npm-only] <root>@<target> [...]")
  process.exit(1)
}

function expectedBinary(target) {
  return target.startsWith("win32-") ? "node.exe" : path.join("bin", "node")
}

function verify(spec) {
  const [root, target] = spec.split("@")
  if (!root || !target) {
    throw new Error(`Invalid verification spec: ${spec}`)
  }

  const runtimeRoot = path.join(root, "node", target)
  const npmRoot = path.join(runtimeRoot, npmRelativePath(target, npmOnly))
  if (npmOnly && fs.existsSync(path.join(runtimeRoot, expectedBinary(target)))) {
    throw new Error(`Electron resources must contain npm only: ${root}`)
  }
  for (const file of [...(npmOnly ? [] : [path.join(runtimeRoot, expectedBinary(target))]), path.join(npmRoot, "bin", "npm-cli.js")]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Missing bundled runtime file: ${file}`)
    }
    console.log(`[verify-bundled-node] ${file}`)
  }
  const npmVersion = JSON.parse(fs.readFileSync(path.join(npmRoot, "package.json"), "utf8")).version
  if (npmVersion !== NPM_VERSION) throw new Error(`Bundled npm ${npmVersion} does not match the ${NPM_VERSION} pin: ${npmRoot}`)
}

for (const target of targets) {
  verify(target)
}
