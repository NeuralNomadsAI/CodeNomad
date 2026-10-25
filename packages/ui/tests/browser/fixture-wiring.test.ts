import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const browserTestsDirectory = fileURLToPath(new URL("./", import.meta.url))

/** Files exempt from a rule because they genuinely cannot satisfy it, each
 * name mapped to the rules it may skip and why. Anything not listed here is
 * required to follow the standard fixture wiring. */
const exemptions: Record<string, Record<string, string>> = {}

/** Helper modules every fixture wiring depends on; imports naming them must
 * resolve to a real file, so a wrong relative specifier fails here instead of
 * failing six test files at module load. */
const helperModules = ["fixture-navigation-budget", "fixture-cache", "fixture-shutdown"]

const RULES = {
  ownedCache: "creates a Vite server but does not use createFixtureCache()",
  cacheDir: "creates a Vite server but no `cacheDir: <cache>.cacheDir` from the owned cache (a default or fixed node_modules/.vite dir corrupts under parallel optimizer writes)",
  shutdownPlugin: "creates a Vite server but shutdown.plugin is not in the server plugins",
  shutdownOwn: "creates a Vite server but shutdown.own(server) is never called, leaving teardown to hang on the optimizer",
  navigationBudget: "launches chromium but never calls armFixtureNavigationBudget(browser), so parallel cold starts can exceed the 30 s default navigation timeout",
  importsResolve: "imports a fixture helper module through a specifier that does not resolve to an existing file",
} as const
type Rule = keyof typeof RULES

/** Any form of module reference to vite: static import, re-export, namespace
 * import or dynamic import — paired with a createServer( call-site below. */
const referencesVite = /(\bfrom\s*["']vite["'])|(import\(\s*["']vite["']\s*\))/

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
    try { source = await readFile(file, "utf8") } catch { continue } // not text (binary fixture assets)
    const relative = path.relative(browserTestsDirectory, file)
    const missing = new Set<Rule>()
    if (referencesVite.test(source) && /createServer\(/.test(source)) {
      if (!/createFixtureCache\(/.test(source)) missing.add("ownedCache")
      if (!/cacheDir:\s*\w+\.cacheDir\b/.test(source)) missing.add("cacheDir")
      if (!/shutdown\.plugin/.test(source)) missing.add("shutdownPlugin")
      if (!/shutdown\.own\(/.test(source)) missing.add("shutdownOwn")
    }
    if (/chromium\.launch/.test(source) && !/armFixtureNavigationBudget\(/.test(source)) missing.add("navigationBudget")
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s+[^;]*?from\s*["'](\.[^"']+)["']/g)].map(match => match[1])
    for (const specifier of specifiers) {
      if (!helperModules.some(helper => specifier.includes(helper))) continue
      if (!(await resolves(specifier, file))) { missing.add("importsResolve"); break }
    }
    const exempt = exemptions[relative]
    for (const rule of [...missing]) if (exempt?.[rule]) missing.delete(rule)
    if (missing.size) violations.set(relative, missing)
  }
  return violations
}

test("every vite fixture owns its cache, protects its shutdown and arms its navigation budget", async () => {
  const violations = await scan()
  const summary = [...violations.entries()]
    .map(([file, rules]) => `${file}: ${[...rules].map(rule => RULES[rule]).join("; ")}`)
    .sort()
  assert.deepEqual(summary, [], `fixture wiring violations (${summary.length} files):\n${summary.join("\n")}`)
})
