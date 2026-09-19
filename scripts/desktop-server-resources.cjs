const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

const excludedDistRoots = new Set(["codenomad-server", "opencode-config", "opencode-config-template", "opencode-config.js"])
const npmTargets = {
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "linux-x64": { os: "linux", cpu: "x64" },
  "linux-arm64": { os: "linux", cpu: "arm64" },
  "win32-x64": { os: "win32", cpu: "x64" },
  "win32-arm64": { os: "win32", cpu: "arm64" },
}

function resolveNpmTarget(target = process.env.CODENOMAD_NODE_TARGET || `${process.platform}-${process.arch}`) {
  const npmTarget = npmTargets[target]
  if (!npmTarget) throw new Error(`Unsupported desktop packaging target: ${target}`)
  return { target, ...npmTarget }
}

function resolveLockDependency(packages, ownerPath, dependency) {
  let current = ownerPath
  while (true) {
    const candidate = current ? `${current}/node_modules/${dependency}` : `node_modules/${dependency}`
    if (packages[candidate]) return candidate
    const nested = current.lastIndexOf("/node_modules/")
    if (nested >= 0) current = current.slice(0, nested)
    else if (current.startsWith("node_modules/")) current = ""
    else {
      const parent = current.lastIndexOf("/")
      current = parent >= 0 ? current.slice(0, parent) : ""
    }
    if (!current) {
      const rootCandidate = `node_modules/${dependency}`
      return packages[rootCandidate] ? rootCandidate : null
    }
  }
}

function validateServerProductionLock(lock) {
  const packages = lock && lock.packages
  if (!packages || !packages["packages/server"]) throw new Error("Root package-lock.json does not contain packages/server")
  const pending = ["packages/server"]
  const visited = new Set()
  while (pending.length) {
    const packagePath = pending.pop()
    if (!packagePath || visited.has(packagePath)) continue
    visited.add(packagePath)
    const pkg = packages[packagePath]
    if (!pkg) throw new Error(`Root package-lock.json is missing ${packagePath}`)
    if (pkg.link && typeof pkg.resolved === "string") {
      pending.push(pkg.resolved)
      continue
    }
    if (!packagePath.startsWith("packages/") && (!pkg.version || !pkg.resolved || !pkg.integrity)) {
      throw new Error(`Root package-lock.json does not integrity-pin ${packagePath}`)
    }
    const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies }
    for (const dependency of Object.keys(dependencies)) {
      const resolved = resolveLockDependency(packages, packagePath, dependency)
      if (!resolved) throw new Error(`Root package-lock.json cannot resolve ${dependency} from ${packagePath}`)
      pending.push(resolved)
    }
  }
  return visited
}

function stagePrebuiltWorkspacePackage(source, destination) {
  const sourceManifest = path.join(source, "package.json")
  const sourceDist = path.join(source, "dist")
  if (!fs.existsSync(sourceDist)) {
    throw new Error(`Missing prebuilt workspace artifact: ${sourceDist}`)
  }

  const manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"))
  delete manifest.scripts
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(path.join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.cpSync(sourceDist, path.join(destination, "dist"), { recursive: true })
}

function stagePackagedServer(options) {
  const { workspaceRoot, serverRoot, log = () => {}, env = process.env } = options
  const npmTarget = resolveNpmTarget(options.target || env.CODENOMAD_NODE_TARGET)
  const lockPath = path.join(workspaceRoot, "package-lock.json")
  const productionClosure = validateServerProductionLock(JSON.parse(fs.readFileSync(lockPath, "utf8")))

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-server-"))
  const stagedServerRoot = path.join(stagingRoot, "packages", "server")
  try {
    fs.mkdirSync(stagedServerRoot, { recursive: true })
    fs.copyFileSync(path.join(workspaceRoot, "package.json"), path.join(stagingRoot, "package.json"))
    fs.copyFileSync(lockPath, path.join(stagingRoot, "package-lock.json"))
    fs.copyFileSync(path.join(serverRoot, "package.json"), path.join(stagedServerRoot, "package.json"))
    for (const packagePath of productionClosure) {
      if (!packagePath.startsWith("packages/") || packagePath === "packages/server" || packagePath.includes("/node_modules/")) continue
      const source = path.join(workspaceRoot, packagePath)
      const destination = path.join(stagingRoot, packagePath)
      stagePrebuiltWorkspacePackage(source, destination)
    }

    log(`installing production server dependencies from the workspace lock for ${npmTarget.target}`)
    const npmArgs = [
      "ci",
      "--workspace",
      "@neuralnomads/codenomad",
      "--include-workspace-root=false",
      "--omit=dev",
      "--ignore-scripts",
      `--os=${npmTarget.os}`,
      `--cpu=${npmTarget.cpu}`,
      "--fund=false",
      "--audit=false",
    ]
    const npmCli = env.npm_execpath && env.npm_node_execpath
      ? [env.npm_node_execpath, [env.npm_execpath, ...npmArgs]]
      : process.platform === "win32"
        ? [env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...npmArgs]]
        : ["npm", npmArgs]
    const result = spawnSync(npmCli[0], npmCli[1], { cwd: stagingRoot, stdio: "inherit", env })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`npm ci exited with code ${result.status ?? 1}`)

    const rootModules = path.join(stagingRoot, "node_modules")
    const serverModules = path.join(stagedServerRoot, "node_modules")
    const serverOverrides = path.join(stagingRoot, "server-node-modules")
    if (fs.existsSync(serverModules)) fs.renameSync(serverModules, serverOverrides)
    fs.rmSync(path.join(rootModules, "@neuralnomads", "codenomad"), { recursive: true, force: true })
    fs.cpSync(rootModules, serverModules, { recursive: true, dereference: true })
    if (fs.existsSync(serverOverrides)) fs.cpSync(serverOverrides, serverModules, { recursive: true, dereference: true })
    for (const artifact of ["public", "dist"]) {
      fs.cpSync(path.join(serverRoot, artifact), path.join(stagedServerRoot, artifact), { recursive: true })
    }
    return { stagingRoot, stagedServerRoot, target: npmTarget.target }
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    throw error
  }
}

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
  resolveNpmTarget,
  stagePrebuiltWorkspacePackage,
  stagePackagedServer,
  validateServerProductionLock,
}
