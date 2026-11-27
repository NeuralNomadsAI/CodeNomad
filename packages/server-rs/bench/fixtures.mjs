// Bench paths (TS dist of this checkout, Rust binary, out/) and fixture installers shared by the modes.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, statSync } from "node:fs"
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

export { assertPrivateHost, sanitizeBenchEnvPath } from "./private-profile.mjs"
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

export function buildPrivateGitEnv(folder, sourceEnv = process.env) {
  return {
    ...Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(path.dirname(folder), "fixture.gitconfig"),
  }
}

/** A Git repository with its own identity and a fake origin URL (never fetched). */
export async function privateGit(folder, slug) {
  await mkdir(folder, { recursive: true })
  const env = buildPrivateGitEnv(folder)
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

const REGEX_PREFIX_KEYWORDS = new Set([
  "return", "throw", "case", "delete", "void", "typeof", "yield", "await",
  "in", "instanceof", "of", "new", "else", "do", "export", "default",
])
const EXPR_BRACE_PRECEDER_PUNCTS = new Set([
  "(", "[", ",", ":", "?", "=", "+", "-", "*", "/", "%", "&", "|", "^", "!", "~", "<", ">",
])
const EXPR_BRACE_PRECEDER_KEYWORDS = new Set([
  "return", "throw", "yield", "await", "typeof", "void", "delete", "in", "instanceof", "of", "new", "case", "default",
])
const STATEMENT_PAREN_KEYWORDS = new Set(["if", "while", "for", "with"])

function decodeJsString(raw) {
  const body = raw.slice(1, -1)
  let out = ""
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== "\\") { out += ch; continue }
    i += 1
    if (i >= body.length) break
    const esc = body[i]
    if (esc === "\r") { if (body[i + 1] === "\n") i += 1; continue }
    if (esc === "\n" || esc === "\u2028" || esc === "\u2029") continue
    if (esc === "n") out += "\n"
    else if (esc === "r") out += "\r"
    else if (esc === "t") out += "\t"
    else if (esc === "b") out += "\b"
    else if (esc === "f") out += "\f"
    else if (esc === "v") out += "\v"
    else if (esc === "0") out += "\0"
    else if (esc === "x" && /^[0-9a-fA-F]{2}/.test(body.slice(i + 1, i + 3))) {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 3), 16))
      i += 2
    } else if (esc === "u" && body[i + 1] === "{") {
      const close = body.indexOf("}", i + 2)
      assert(close > i + 2, `Invalid Unicode escape in string literal: ${raw}`)
      out += String.fromCodePoint(Number.parseInt(body.slice(i + 2, close), 16))
      i = close
    } else if (esc === "u" && /^[0-9a-fA-F]{4}/.test(body.slice(i + 1, i + 5))) {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16))
      i += 4
    } else {
      out += esc
    }
  }
  return out
}

function tokenizeEsm(code) {
  const tokens = []
  const templateBraceStack = []
  const parenHeaderStack = []
  const braceKindStack = []
  let i = 0
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n")
    i = nl === -1 ? code.length : nl + 1
  }
  const isExprPrecederAt = (idx, allowArrow = false) => {
    const prev = idx >= 0 ? tokens[idx] : null
    if (!prev) return false
    if (prev.type === "template-head") return true
    if (prev.type === "ident") {
      if (allowArrow && prev.value === "default" && tokens[idx - 1]?.type === "ident" && tokens[idx - 1].value === "export") {
        return false
      }
      return EXPR_BRACE_PRECEDER_KEYWORDS.has(prev.value)
    }
    if (prev.type === "punct") {
      if (prev.value === ">" && tokens[idx - 1]?.type === "punct" && tokens[idx - 1]?.value === "=") return allowArrow
      return EXPR_BRACE_PRECEDER_PUNCTS.has(prev.value)
    }
    return false
  }
  const isFunctionExprHeader = () => {
    let idx = tokens.length - 1
    if (tokens[idx]?.type === "ident" && tokens[idx].value !== "function") idx -= 1
    if (tokens[idx]?.type === "punct" && tokens[idx].value === "*") idx -= 1
    if (!(tokens[idx]?.type === "ident" && tokens[idx].value === "function")) return false
    if (tokens[idx - 1]?.type === "ident" && tokens[idx - 1].value === "async") idx -= 1
    return isExprPrecederAt(idx - 1, true)
  }
  const isClassExprBody = () => {
    let depth = 0
    for (let idx = tokens.length - 1; idx >= 0; idx -= 1) {
      const tok = tokens[idx]
      if (tok.type === "punct") {
        if (tok.value === ")" || tok.value === "]" || tok.value === "}") { depth += 1; continue }
        if (tok.value === "(" || tok.value === "[" || tok.value === "{") {
          if (depth === 0) return false
          depth -= 1
          continue
        }
        if (depth === 0 && tok.value === ";") return false
      }
      if (tok.type === "template-head" && depth === 0) return false
      if (depth === 0 && tok.type === "ident" && tok.value === "class") {
        const before = tokens[idx - 1]
        if (before?.type === "punct" && (before.value === "." || before.value === "?.")) continue
        return isExprPrecederAt(idx - 1, true)
      }
    }
    return false
  }
  const opensExprBrace = () => {
    const prev = tokens.at(-1)
    if (!prev) return false
    if (prev.type === "punct" && prev.value === ")" && prev.fnExprClose === true) return true
    if (isExprPrecederAt(tokens.length - 1)) return true
    return isClassExprBody()
  }
  const canStartRegex = () => {
    const prev = tokens.at(-1)
    if (!prev || prev.type === "template-head") return true
    if (prev.type === "ident") return REGEX_PREFIX_KEYWORDS.has(prev.value)
    if (prev.type === "punct") {
      if (prev.value === ")") return prev.headerClose === true
      if (prev.value === "}") return prev.exprClose !== true
      return prev.value !== "]" && prev.value !== "++" && prev.value !== "--"
    }
    return false
  }
  const scanTemplateChunk = start => {
    let j = start + 1
    while (j < code.length) {
      const ch = code[j]
      if (ch === "\\") { j += 2; continue }
      if (ch === "`") {
        tokens.push({ type: "template", start, end: j + 1 })
        return j + 1
      }
      if (ch === "$" && code[j + 1] === "{") {
        tokens.push({ type: "template-head", start, end: j + 2 })
        templateBraceStack.push(0)
        return j + 2
      }
      j += 1
    }
    tokens.push({ type: "template", start, end: code.length })
    return code.length
  }
  while (i < code.length) {
    const ch = code[i]
    if (/\s/.test(ch)) { i += 1; continue }
    if (ch === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i + 2)
      i = nl === -1 ? code.length : nl + 1
      continue
    }
    if (ch === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2)
      i = close === -1 ? code.length : close + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      while (j < code.length) {
        if (code[j] === "\\") { j += 2; continue }
        if (code[j] === quote) { j += 1; break }
        j += 1
      }
      const raw = code.slice(i, j)
      tokens.push({ type: "string", start: i, end: j, raw, value: decodeJsString(raw) })
      i = j
      continue
    }
    if (ch === "`") {
      i = scanTemplateChunk(i)
      continue
    }
    if (ch === "{") {
      if (templateBraceStack.length > 0) templateBraceStack[templateBraceStack.length - 1] += 1
      braceKindStack.push(opensExprBrace())
      tokens.push({ type: "punct", value: "{", start: i, end: i + 1 })
      i += 1
      continue
    }
    if (ch === "}") {
      if (templateBraceStack.length > 0 && templateBraceStack.at(-1) === 0) {
        templateBraceStack.pop()
        i = scanTemplateChunk(i)
        continue
      }
      if (templateBraceStack.length > 0) templateBraceStack[templateBraceStack.length - 1] -= 1
      const exprClose = braceKindStack.pop() ?? false
      tokens.push({ type: "punct", value: "}", start: i, end: i + 1, exprClose })
      i += 1
      continue
    }
    if (ch === "/" && canStartRegex()) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < code.length) {
        const c = code[j]
        if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") break
        if (c === "\\") { j += 2; continue }
        if (c === "[") { inClass = true; j += 1; continue }
        if (c === "]") { inClass = false; j += 1; continue }
        if (c === "/" && !inClass) { j += 1; closed = true; break }
        j += 1
      }
      if (closed) {
        while (j < code.length && /[A-Za-z]/.test(code[j])) j += 1
        tokens.push({ type: "regex", start: i, end: j })
        i = j
        continue
      }
      tokens.push({ type: "punct", value: "/", start: i, end: i + 1 })
      i += 1
      continue
    }
    if (/[A-Za-z_$]/.test(ch) || ch.charCodeAt(0) >= 0x80) {
      let j = i + 1
      while (j < code.length && (/[\w$]/.test(code[j]) || code.charCodeAt(j) >= 0x80)) j += 1
      tokens.push({ type: "ident", value: code.slice(i, j), start: i, end: j })
      i = j
      continue
    }
    if (/\d/.test(ch) || (ch === "." && /\d/.test(code[i + 1] ?? ""))) {
      let j = i + 1
      while (j < code.length && /[\w.]/.test(code[j])) {
        if ((code[j] === "e" || code[j] === "E") && (code[j + 1] === "+" || code[j + 1] === "-")) j += 2
        else j += 1
      }
      tokens.push({ type: "number", start: i, end: j })
      i = j
      continue
    }
    if (ch === "(") {
      const prev = tokens.at(-1)
      parenHeaderStack.push({
        headerClose: prev?.type === "ident" && STATEMENT_PAREN_KEYWORDS.has(prev.value),
        fnExprClose: isFunctionExprHeader(),
      })
      tokens.push({ type: "punct", value: "(", start: i, end: i + 1 })
      i += 1
      continue
    }
    if (ch === ")") {
      const parenKind = parenHeaderStack.pop() ?? { headerClose: false, fnExprClose: false }
      tokens.push({ type: "punct", value: ")", start: i, end: i + 1, headerClose: parenKind.headerClose, fnExprClose: parenKind.fnExprClose })
      i += 1
      continue
    }
    const two = code.slice(i, i + 2)
    if (two === "++" || two === "--" || two === "?.") {
      tokens.push({ type: "punct", value: two, start: i, end: i + 2 })
      i += 2
      continue
    }
    tokens.push({ type: "punct", value: ch, start: i, end: i + 1 })
    i += 1
  }
  return tokens
}

function collectEsmSpecifierTokens(tokens) {
  const specifiers = []
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]
    if (tok.type !== "ident") continue
    const prev = k > 0 ? tokens[k - 1] : null
    if (prev?.type === "punct" && (prev.value === "." || prev.value === "?.")) continue
    if (tok.value === "import") {
      const next = tokens[k + 1]
      if (!next) continue
      if (next.type === "string") {
        specifiers.push(next)
        continue
      }
      if (next.type === "punct" && next.value === "(") {
        const arg = tokens[k + 2]
        const after = tokens[k + 3]
        if (arg?.type === "string" && after?.type === "punct" && (after.value === ")" || after.value === ",")) {
          specifiers.push(arg)
        }
        continue
      }
      if (next.type === "punct" && next.value === ".") continue
      let j = k + 1
      if (tokens[j]?.type === "ident") {
        j += 1
        if (tokens[j]?.type === "punct" && tokens[j].value === ",") j += 1
      }
      if (tokens[j]?.type === "punct" && tokens[j].value === "*") {
        if (tokens[j + 1]?.type === "ident" && tokens[j + 1].value === "as" && tokens[j + 2]?.type === "ident") {
          j += 3
        } else {
          continue
        }
      } else if (tokens[j]?.type === "punct" && tokens[j].value === "{") {
        let braceDepth = 1
        j += 1
        while (j < tokens.length && braceDepth > 0) {
          if (tokens[j].type === "punct" && tokens[j].value === "{") braceDepth += 1
          else if (tokens[j].type === "punct" && tokens[j].value === "}") braceDepth -= 1
          j += 1
        }
        if (braceDepth !== 0) continue
      }
      if (j > k + 1 && tokens[j]?.type === "ident" && tokens[j].value === "from" && tokens[j + 1]?.type === "string") {
        specifiers.push(tokens[j + 1])
      }
      continue
    }
    if (tok.value === "export") {
      const next = tokens[k + 1]
      if (!next) continue
      if (next.type === "punct" && next.value === "*") {
        let j = k + 2
        if (tokens[j]?.type === "ident" && tokens[j].value === "as"
          && (tokens[j + 1]?.type === "ident" || tokens[j + 1]?.type === "string")) {
          j += 2
        }
        if (tokens[j]?.type === "ident" && tokens[j].value === "from" && tokens[j + 1]?.type === "string") {
          specifiers.push(tokens[j + 1])
        }
        continue
      }
      if (next.type === "punct" && next.value === "{") {
        let braceDepth = 1
        let j = k + 2
        while (j < tokens.length && braceDepth > 0) {
          if (tokens[j].type === "punct" && tokens[j].value === "{") braceDepth += 1
          else if (tokens[j].type === "punct" && tokens[j].value === "}") braceDepth -= 1
          j += 1
        }
        if (braceDepth === 0 && tokens[j]?.type === "ident" && tokens[j].value === "from" && tokens[j + 1]?.type === "string") {
          specifiers.push(tokens[j + 1])
        }
      }
    }
  }
  return specifiers
}

/** Rewrites every relative ESM specifier in `code` to an absolute `file://` URL rooted at `sourceFile`. */
export function rewriteFixtureImports(code, sourceFile) {
  const sourceUrl = pathToFileURL(path.resolve(sourceFile))
  const specifierTokens = collectEsmSpecifierTokens(tokenizeEsm(code))
  const replacements = []
  for (const token of specifierTokens) {
    if (!/^\.\.?\//.test(token.value)) continue
    const resolved = new URL(token.value, sourceUrl)
    assert.equal(resolved.protocol, "file:", `Unexpected non-file import URL in ${sourceFile}: ${token.value}`)
    const fileUrl = new URL(resolved.href)
    fileUrl.search = ""
    fileUrl.hash = ""
    const target = fileURLToPath(fileUrl)
    assert(existsSync(target) && statSync(target).isFile(), `Missing relative import target in ${sourceFile}: ${token.value}`)
    replacements.push({ start: token.start, end: token.end, text: JSON.stringify(resolved.href) })
  }
  assert(replacements.length > 0, `Expected at least one relative import in ${sourceFile}`)
  let output = ""
  let cursor = 0
  for (const { start, end, text } of replacements) {
    output += code.slice(cursor, start) + text
    cursor = end
  }
  return output + code.slice(cursor)
}

/** The fixture daemon module with a short provider delay and a Git ceiling: the bench lies inside the
 * CodeNomad checkout, whose repository must stay invisible to it. Returns its runner and a cleanup. */
export async function productRuntime({ holdProvider, gitCeiling = true } = {}) {
  const source = path.join(repo, "scripts/native-product-fixture.mjs")
  const file = path.join(out, `native-product-fixture-${process.pid}-${randomUUID()}.mjs`)
  const edits = [['      res.end("data: [DONE]\\n\\n")', "      await delay(60)\n"]]
  if (gitCeiling) edits.push(["  await mkdir(env.OPENCODE_CONFIG_DIR)", "  env.GIT_CEILING_DIRECTORIES = root\n"])
  if (holdProvider) edits.push(['      res.setHeader("Content-Type", "text/event-stream")',
    `      if (JSON.stringify(requests.at(-1).messages).includes(${JSON.stringify(holdProvider)})) {\n        await new Promise(resolve => res.once("close", resolve))\n        return\n      }\n`])
  let code = await readFile(source, "utf8")
  for (const [marker, before] of edits) { assert.equal(code.split(marker).length, 2, marker); code = code.replace(marker, before + marker) }
  code = rewriteFixtureImports(code, source)
  let created = false
  try {
    await writeFile(file, code, { flag: "wx" })
    created = true
    const { withProductRuntime } = await import(pathToFileURL(file))
    return { withProductRuntime, file, remove: () => rm(file, { force: true }) }
  } catch (error) {
    if (created || error?.code !== "EEXIST") await rm(file, { force: true }).catch(() => {})
    throw error
  }
}
