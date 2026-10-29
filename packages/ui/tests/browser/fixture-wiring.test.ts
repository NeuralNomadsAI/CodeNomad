import assert from "node:assert/strict"
import { readdir, readFile, access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { exemptions } from "./fixture-exemptions"

const browserTestsDirectory = fileURLToPath(new URL("./", import.meta.url))

/** Files that keep their own server (or no fixture page at all) instead of
 * borrowing from the shared daemon. Each name maps to the reason; Vite-hosting
 * entries must also satisfy the owned-server rules below. Anything not listed
 * must borrow. */


/** Helper modules every fixture depends on; imports naming them must resolve
 * to a real file, so a wrong relative specifier fails here instead of failing
 * six test files at module load. */
const helperModules = ["fixture-navigation-budget", "fixture-cache", "fixture-shutdown", "fixture-borrow", "fixture-daemon/server", "fixture-daemon/run"]

const RULES = {
  ownedCache: "hosts a Vite server but does not use createFixtureCache()",
  cacheDir: "hosts a Vite server but no `cacheDir: <cache>.cacheDir` from the owned cache (a default or fixed node_modules/.vite dir corrupts under parallel optimizer writes)",
  shutdownPlugin: "hosts a Vite server but shutdown.plugin is not in the server plugins",
  shutdownOwn: "hosts a Vite server but shutdown.own(server) is never called, leaving teardown to hang on the optimizer",
  navigationBudget: "launches chromium but never calls armFixtureNavigationBudget(browser), so parallel cold starts can exceed the 30 s default navigation timeout",
  importsResolve: "imports a fixture helper module through a specifier that does not resolve to an existing file",
  mustBorrow: "test file neither borrows from the shared daemon nor is listed in the exemption map — add borrowFixture() or exempt it with a reason",
  noSelfServer: "test file imports createServer from vite although it is not exempted — borrow from the shared daemon or exempt it with a reason",
} as const
type Rule = keyof typeof RULES

const referencesVite = /(\bfrom\s*["']vite["'])|(import\(\s*["']vite["']\s*\))/
const createsViteServerImport = /import\s*\{[^}]*createServer[^}]*\}\s*from\s*["']vite["']/

async function resolves(specifier: string, fromFile: string): Promise<boolean> {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.mjs`, path.join(base, "index.ts")]) {
    try { await access(candidate); return true } catch { /* try the next form */ }
  }
  return false
}

async function scan(): Promise<Map<string, Set<Rule>>> {
  const violations = new Map<string, Set<Rule>>()
  const entries = await readdir(browserTestsDirectory, { recursive: true })
  const files = (entries as string[])
    .map(entry => path.join(browserTestsDirectory, entry))
    .filter(file => !file.endsWith("fixture-wiring.test.ts"))
  for (const file of files) {
    let source: string
    try { source = await readFile(file, "utf8") } catch { continue } // binary fixture assets
    const relative = path.relative(browserTestsDirectory, file).split(path.sep).join("/")
    const missing = new Set<Rule>()
    const exempt = exemptions[relative]
    const isTest = /\.test\.ts$/.test(relative)
    const createsViteServer = referencesVite.test(source) && /createServer\(/.test(source)
    if (createsViteServer) {
      if (!/createFixtureCache\(/.test(source)) missing.add("ownedCache")
      if (!/cacheDir:\s*\w+\.cacheDir\b/.test(source)) missing.add("cacheDir")
      if (!/shutdown\.plugin/.test(source)) missing.add("shutdownPlugin")
      if (!/shutdown\.own\(/.test(source)) missing.add("shutdownOwn")
    }
    if (/chromium\.launch/.test(source) && !/armFixtureNavigationBudget\(/.test(source)) missing.add("navigationBudget")
    if (isTest && !exempt) {
      if (!/borrowFixture\(/.test(source)) missing.add("mustBorrow")
      if (createsViteServerImport.test(source)) missing.add("noSelfServer")
    }
    if (!isTest && !exempt && createsViteServerImport.test(source)) missing.add("noSelfServer")
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s+[^;]*?from\s*["'](\.[^"']+)["']/g)].map(match => match[1])
    for (const specifier of specifiers) {
      if (!helperModules.some(helper => specifier.includes(helper))) continue
      if (!(await resolves(specifier, file))) { missing.add("importsResolve"); break }
    }
    if (missing.size) violations.set(relative, missing)
  }
  return violations
}

test("every fixture borrows from the daemon or carries an explicit exemption with owned-server wiring", async () => {
  const violations = await scan()
  const summary = [...violations.entries()]
    .map(([file, rules]) => `${file}: ${[...rules].map(rule => RULES[rule]).join("; ")}`)
    .sort()
  assert.deepEqual(summary, [], `fixture wiring violations (${summary.length} files):
${summary.join("\n")}`)
})
