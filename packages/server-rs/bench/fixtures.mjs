// Bench paths (TS dist of this checkout, Rust binary, out/) and fixture installers shared by the modes.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { register } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { ownedOutput } from "./private-profile.mjs"

export const repo = fileURLToPath(new URL("../../../", import.meta.url))
export const dist = pathToFileURL(path.join(repo, "packages/server/dist/"))
const output = fileURLToPath(new URL("./out/", import.meta.url))
export const out = await ownedOutput(repo, output)
await mkdir(out, { recursive: true })
let distRegistered = false
export function ensureDist() {
  if (distRegistered) return
  assert(existsSync(new URL("index.js", dist)), "Build the TS server first: npm run build --workspace @neuralnomads/codenomad")
  register(new URL("loader.js", dist), import.meta.url)
  distRegistered = true
}
export const fromDist = file => { ensureDist(); return import(new URL(file, dist)) }

/** Private temp tree of every fixture (the bench lies inside the CodeNomad checkout: see the Git ceiling in compare.mjs). */
export async function useBenchTemp() {
  process.env.TMP = process.env.TEMP = process.env.TMPDIR = path.join(out, "tmp")
  await mkdir(process.env.TMP, { recursive: true })
}

export { assertPrivateHost } from "./private-profile.mjs"
const assertFixtureRoot = root => assert(path.resolve(root).startsWith(path.join(out, "tmp", "opencode")), `Not a bench fixture: ${root}`)

/** A forced stop skips a server's own removal: drop `pid`'s bridge registration from its fixture registry. */
export async function dropRegistration(env, pid) {
  const registry = path.join(env.LOCALAPPDATA, "CodeNomad", "automation-bridges")
  const parent = process.env.CODENOMAD_NATIVE_FIXTURE_PARENT
  const root = path.resolve(env.USERPROFILE)
  assert(path.resolve(env.LOCALAPPDATA) === path.join(root, "AppData", "Local"))
  const allowed = [path.join(out, "tmp"), ...(parent ? [path.resolve(parent)] : [])]
  assert(allowed.some(dir => path.relative(dir, root).split(path.sep).length === 2
    && path.dirname(root) === path.join(dir, "opencode") && /^product-native-[A-Za-z0-9]+$/.test(path.basename(root))),
  `Not a bench registry: ${registry}`)
  for (const name of await readdir(registry).catch(() => [])) if (name.includes(`-${pid}-`)) await rm(path.join(registry, name), { force: true })
}

export function rustBinary() {
  const bin = process.env.CODENOMAD_RS_BINARY ?? process.env.CNRS_RUST_BINARY
    ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(repo, "packages/server-rs/target"), "release", `codenomad-rs${process.platform === "win32" ? ".exe" : ""}`)
  assert(path.isAbsolute(bin) && existsSync(bin), `Rust binary not found: ${bin} (CODENOMAD_RS_BINARY, CNRS_RUST_BINARY or CARGO_TARGET_DIR)`)
  return bin
}

export const PRUNING_READY_TIMEOUT_MS = 12000

/** Wait until OpenCode has booted `directory` and activated `codenomad-session-pruning`. */
export async function waitForPruningPlugin(client, directory, signal = AbortSignal.timeout(PRUNING_READY_TIMEOUT_MS)) {
  const location = { directory }
  await client.location.get({ location }, { signal })
  const { awaitNativePlugin } = await fromDist("opencode/plugin-activation.js")
  await awaitNativePlugin(client, "codenomad-session-pruning", location, signal)
}

/** The bundled pruning plugin in the Rust fixture profile, as the TS server installs its own. */
export async function installPruning({ root, configDirectory }) {
  assertFixtureRoot(root)
  const { installPruningPresence } = await fromDist("opencode/pruning-installation.js")
  const presence = await installPruningPresence(await readFile(new URL("plugins/session-pruning/plugin.mjs", dist)),
    { config: configDirectory, data: path.join(root, "rust-fixture-presence") })
  return {
    close: presence,
    async ready(client, directory) {
      const signal = AbortSignal.timeout(PRUNING_READY_TIMEOUT_MS)
      await waitForPruningPlugin(client, directory, signal)
      await presence.prepare(directory, signal, () => {})
    },
  }
}

/** The same bundled plugin backs both servers' Missions routes. */
export async function installMissions({ root, configDirectory }) {
  assertFixtureRoot(root)
  const { installDesktopPluginPresence } = await fromDist("opencode/desktop-plugin-installation.js")
  const [bundle, provider] = await Promise.all(["plugin.mjs", "provider.mjs"].map(name => readFile(new URL(`plugins/missions/${name}`, dist))))
  return installDesktopPluginPresence("missions", bundle, { config: configDirectory, data: path.join(root, "missions-presence") }, () => {}, () => "", provider)
}

/** Rust provisions the bundled plugins itself (memory, Design leases), like the TS server. */
export const provisionEnv = (root, plugins = "1") => ({ CNRS_PROVISION_PLUGINS: plugins,
  CNRS_PLUGIN_ASSETS: fileURLToPath(new URL("plugins/", dist)), CNRS_PLUGIN_PROFILE_ROOT: root })

/** A Git repository with its own identity and a fake origin URL (never fetched). */
export async function privateGit(folder, slug) {
  await mkdir(folder, { recursive: true })
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(path.dirname(folder), "fixture.gitconfig") }
  const git = (...args) => promisify(execFile)("git", args, { windowsHide: true, env })
  await git("init", "--quiet", folder)
  await git("-C", folder, "remote", "add", "origin", `https://fixture.invalid/${slug}.git`)
}

/** Windows private bytes and working set of each PID. */
export async function memory(pids) {
  assert(pids.every(pid => Number.isSafeInteger(pid) && pid > 0))
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `@(${pids.join(",")}) | ForEach-Object { $p=Get-Process -Id $_ -ErrorAction Stop; "{0},{1}" -f $p.PrivateMemorySize64,$p.WorkingSet64 }`], { windowsHide: true })
  return stdout.trim().split(/\r?\n/).map(row => { const [privateBytes, workingSet] = row.split(",").map(Number); return { privateBytes, workingSet } })
}
/** Medians of five readings per PID. */
export async function measurePair(ts, rs) {
  const reads = []
  for (let i = 0; i < 5; i++) { if (i) await new Promise(r => setTimeout(r, 80)); reads.push(await memory([ts.pid, rs.pid])) }
  const median = rows => Object.fromEntries(["privateBytes", "workingSet"].map(key => {
    const sorted = rows.map(row => row[key]).sort((a, b) => a - b), i = sorted.length >> 1
    return [key, sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2]
  }))
  return { typescript: median(reads.map(r => r[0])), rust: median(reads.map(r => r[1])), raw: reads }
}

export const writeJson = (name, value) => writeFile(path.join(out, name), JSON.stringify(value, null, 2))

const RELATIVE_IMPORT_RE = /(\bfrom\s*|(?<![\w$.])import\s*\(\s*|(?:^|[;\n])[ \t]*import[ \t]+)(["'])(\.\.?\/[^"'`\r\n]+)\2/g

/** Rewrites every relative ESM specifier in `code` to an absolute `file://` URL rooted at `sourceFile`. */
export function rewriteFixtureImports(code, sourceFile) {
  const baseDir = path.dirname(path.resolve(sourceFile))
  let rewritten = 0
  const output = code.replace(RELATIVE_IMPORT_RE, (_match, prefix, _quote, specifier) => {
    const target = path.resolve(baseDir, specifier)
    assert(existsSync(target), `Missing relative import target in ${sourceFile}: ${specifier}`)
    rewritten += 1
    return `${prefix}${JSON.stringify(pathToFileURL(target).href)}`
  })
  assert(rewritten > 0, `Expected at least one relative import in ${sourceFile}`)
  return output
}

let runtimeCounter = 0

/** The fixture daemon module with a short provider delay and a Git ceiling: the bench lies inside the
 * CodeNomad checkout, whose repository must stay invisible to it. Returns its runner and a cleanup. */
export async function productRuntime({ holdProvider, gitCeiling = true } = {}) {
  const source = path.join(repo, "scripts/native-product-fixture.mjs")
  const file = path.join(out, `native-product-fixture-${process.pid}-${++runtimeCounter}.mjs`)
  const edits = [['      res.end("data: [DONE]\\n\\n")', "      await delay(60)\n"]]
  if (gitCeiling) edits.push(["  await mkdir(env.OPENCODE_CONFIG_DIR)", "  env.GIT_CEILING_DIRECTORIES = root\n"])
  if (holdProvider) edits.push(['      res.setHeader("Content-Type", "text/event-stream")',
    `      if (JSON.stringify(requests.at(-1).messages).includes(${JSON.stringify(holdProvider)})) {\n        await new Promise(resolve => res.once("close", resolve))\n        return\n      }\n`])
  let code = await readFile(source, "utf8")
  for (const [marker, before] of edits) { assert.equal(code.split(marker).length, 2, marker); code = code.replace(marker, before + marker) }
  code = rewriteFixtureImports(code, source)
  await writeFile(file, code)
  try {
    const { withProductRuntime } = await import(pathToFileURL(file))
    return { withProductRuntime, file, remove: () => rm(file, { force: true }) }
  } catch (error) {
    await rm(file, { force: true }).catch(() => {})
    throw error
  }
}
