const fs = require("fs")
const path = require("path")

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

  const binary = path.join(root, "node", target, npmOnly ? "npm/bin/npm-cli.js" : expectedBinary(target))
  if (npmOnly && fs.existsSync(path.join(root, "node", target, expectedBinary(target)))) {
    throw new Error(`Electron resources must contain npm only: ${root}`)
  }
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) {
    throw new Error(`Missing bundled runtime file: ${binary}`)
  }

  console.log(`[verify-bundled-node] ${binary}`)
}

for (const target of targets) {
  verify(target)
}
