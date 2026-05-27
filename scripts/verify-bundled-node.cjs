const fs = require("fs")
const path = require("path")

const targets = process.argv.slice(2)

if (targets.length === 0) {
  console.error("Usage: node scripts/verify-bundled-node.cjs <root>[@<target>] [...]")
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

  const binary = path.join(root, "node", target, expectedBinary(target))
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) {
    throw new Error(`Missing bundled Node binary: ${binary}`)
  }

  console.log(`[verify-bundled-node] ${binary}`)
}

for (const target of targets) {
  verify(target)
}
