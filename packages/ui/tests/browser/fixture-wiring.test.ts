import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const browserTestsDirectory = fileURLToPath(new URL("./", import.meta.url))

/** Files exempt from a rule because they genuinely cannot satisfy it, each
 * name mapped to the rules it may skip and why. Anything not listed here is
 * required to follow the standard fixture wiring. */
const exemptions: Record<string, Record<string, string>> = {}

const RULES = {
  ownedCache: "imports createServer from vite but does not use createFixtureCache()",
  cacheDir: "imports createServer from vite but no `cacheDir: <cache>.cacheDir` from the owned cache (a default or fixed node_modules/.vite dir corrupts under parallel optimizer writes)",
  shutdownPlugin: "imports createServer from vite but shutdown.plugin is not in the server plugins",
  shutdownOwn: "imports createServer from vite but shutdown.own(server) is never called, leaving teardown to hang on the optimizer",
  navigationBudget: "launches chromium but never calls armFixtureNavigationBudget(browser), so parallel cold starts can exceed the 30 s default navigation timeout",
} as const
type Rule = keyof typeof RULES

async function scan(): Promise<Map<string, Set<Rule>>> {
  const violations = new Map<string, Set<Rule>>()
  const entries = await readdir(browserTestsDirectory, { recursive: true })
  const files = (entries as string[])
    .map(entry => path.join(browserTestsDirectory, entry))
    .filter(file => [".ts", ".mjs"].includes(path.extname(file)))
    .filter(file => !file.endsWith("fixture-wiring.test.ts"))
  for (const file of files) {
    const source = await readFile(file, "utf8")
    const relative = path.relative(browserTestsDirectory, file)
    const missing = new Set<Rule>()
    const createsViteServer = /import\s*\{[^}]*createServer[^}]*\}\s*from\s*["']vite["']/.test(source)
    if (createsViteServer) {
      if (!/createFixtureCache\(/.test(source)) missing.add("ownedCache")
      if (!/cacheDir:\s*\w+\.cacheDir\b/.test(source)) missing.add("cacheDir")
      if (!/shutdown\.plugin/.test(source)) missing.add("shutdownPlugin")
      if (!/shutdown\.own\(/.test(source)) missing.add("shutdownOwn")
    }
    if (/chromium\.launch/.test(source) && !/armFixtureNavigationBudget\(/.test(source)) missing.add("navigationBudget")
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
