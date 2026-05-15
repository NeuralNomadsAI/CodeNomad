const fs = require("fs")
const path = require("path")

const excludedDistRoots = new Set(["codenomad-server", "opencode-config", "opencode-config-template", "opencode-config.js"])

function copyPackagedServerResources(options) {
  const { serverRoot, serverDest, log = () => {} } = options

  fs.rmSync(serverDest, { recursive: true, force: true })
  fs.mkdirSync(serverDest, { recursive: true })

  copyRequiredArtifact(serverRoot, serverDest, "package.json", log)
  copyRequiredArtifact(serverRoot, serverDest, "public", log)
  copyRequiredArtifact(serverRoot, serverDest, "node_modules", log)
  copyServerDist(serverRoot, serverDest, log)
  stripNodeModuleBins(path.join(serverDest, "node_modules"), log)
  pruneKnownServerDependencies(path.join(serverDest, "node_modules"), log)
}

function copyRequiredArtifact(serverRoot, serverDest, name, log) {
  const from = path.join(serverRoot, name)
  const to = path.join(serverDest, name)
  if (!fs.existsSync(from)) {
    throw new Error(`Missing required server artifact: ${from}`)
  }
  fs.cpSync(from, to, { recursive: true, dereference: true })
  log(`copied ${name}`)
}

function copyServerDist(serverRoot, serverDest, log) {
  const from = path.join(serverRoot, "dist")
  const to = path.join(serverDest, "dist")

  if (!fs.existsSync(from)) {
    throw new Error(`Missing required server artifact: ${from}`)
  }

  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter(source) {
      const relative = path.relative(from, source)
      if (!relative) return true
      const [root] = relative.split(path.sep)
      if (excludedDistRoots.has(root)) return false
      return !/\.test\.js$/.test(path.basename(relative))
    },
  })
  log("copied filtered dist")
}

function stripNodeModuleBins(root, log) {
  if (!fs.existsSync(root)) return

  const stack = [root]
  let removed = 0

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break

    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.name === ".bin") {
        fs.rmSync(full, { recursive: true, force: true })
        removed += 1
        continue
      }
      if (entry.isDirectory()) {
        stack.push(full)
      }
    }
  }

  if (removed > 0) {
    log(`removed ${removed} node_modules/.bin directories`)
  }
}

function removeIfExists(target) {
  if (!fs.existsSync(target)) return 0
  fs.rmSync(target, { recursive: true, force: true })
  return 1
}

function removeFilesMatching(root, patterns) {
  if (!fs.existsSync(root)) return 0

  const stack = [root]
  let removed = 0

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break

    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }

      if (entry.isFile() && patterns.some((pattern) => pattern.test(entry.name))) {
        fs.rmSync(full, { force: true })
        removed += 1
      }
    }
  }

  return removed
}

function prunePackage(root, options) {
  if (!fs.existsSync(root)) return 0

  let removed = 0
  for (const relativePath of options.remove ?? []) {
    removed += removeIfExists(path.join(root, relativePath))
  }
  if (options.filePatterns?.length) {
    removed += removeFilesMatching(root, options.filePatterns)
  }
  return removed
}

function pruneKnownServerDependencies(root, log) {
  if (!fs.existsSync(root)) return

  let removed = 0
  const declarationAndMaps = [/\.d\.[cm]?ts$/, /\.map$/]
  const packageDocs = [/\.md$/i, /\.markdown$/i]

  removed += prunePackage(path.join(root, "openai"), {
    remove: ["CHANGELOG.md", "README.md", "bin", "src"],
    filePatterns: [...declarationAndMaps],
  })
  removed += prunePackage(path.join(root, "fastify"), {
    remove: ["docs", "examples", "integration", "test", "types", "build", "fastify.d.ts"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "@fastify", "cors"), {
    remove: ["bench.js", "benchmark", "test", "types"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "@fastify", "reply-from"), {
    remove: ["examples", "test", "types"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "@fastify", "static"), {
    remove: ["example", "test", "types", "tsconfig.eslint.json"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "pino"), {
    remove: [
      "benchmarks",
      "browser.js",
      "build",
      "docs",
      "docsify",
      "examples",
      "favicon-16x16.png",
      "favicon-32x32.png",
      "favicon.ico",
      "index.html",
      "pino-banner.png",
      "pino-logo-hire.png",
      "pino-tree.png",
      "pino.d.ts",
      "pretty-demo.png",
      "test",
      "tsconfig.json",
    ],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "undici"), {
    remove: ["docs", "index.d.ts", "scripts", "types"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "zod"), {
    remove: ["README.md", "src"],
    filePatterns: [...declarationAndMaps],
  })
  removed += prunePackage(path.join(root, "yaml"), {
    remove: ["README.md", "bin.mjs", "browser"],
    filePatterns: [...declarationAndMaps],
  })
  removed += prunePackage(path.join(root, "node-forge"), {
    remove: ["README.md", "flash"],
  })

  if (removed > 0) {
    log(`removed ${removed} known non-runtime files/directories from server dependencies`)
  }
}

module.exports = {
  copyPackagedServerResources,
}
