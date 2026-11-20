// Parity cases for `src/file_search/fuzzy.rs` from the TS server's fuzzysort: a target pool (real paths of
// this checkout, their lowercased keys, Unicode, separator, space and length edge cases), `single` pairs and
// `go` runs with limits, duplicates and ties. Scores are compared bit for bit (hex of the IEEE double).
//   node generate-fuzzy-cases.mjs [output folder]   (default tests/fixtures)
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../../../", import.meta.url))
const out = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../tests/fixtures"))
const fuzzysort = createRequire(path.join(repo, "packages/server/package.json"))("fuzzysort")
const version = JSON.parse(fs.readFileSync(createRequire(path.join(repo, "packages/server/package.json")).resolve("fuzzysort/package.json"), "utf8")).version

let seed = 0x5eed1234
const random = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
const pick = list => list[Math.floor(random() * list.length)]
const int = (min, max) => min + Math.floor(random() * (max - min + 1))

const skip = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".cache", "coverage", "target", "out", "public"])
const real = []
const walk = (dir, rel) => {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (skip.has(e.name)) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    real.push(r)
    if (e.isDirectory() && real.length < 40000) walk(path.join(dir, e.name), r)
  }
}
walk(path.join(repo, "packages"), "packages")
const realSample = []
for (let i = 0; i < 1400 && real.length; i++) realSample.push(pick(real))

const unicode = [
  "dossier/étude.txt", "Dossier/Étude Finale.md", "straße/STRASSE.txt", "İstanbul/iı.txt", "ΣΟΦΟΣ/σοφος.md", "ΟΔΟΣ ΣΑΣ/ὈΔΥΣΣΕΎΣ.txt",
  "emoji/😀-smile.ts", "emoji/a😀b😀c.ts", "日本語/ファイル名.tsx", "한국어/파일.rs", "mixed/ÀÉÎõü.json", "ǅungla/ǈ.txt", "ﬁle/ﬀ.txt",
  "Kelvin/K.txt", "Ångström/Å.txt", "dotless/ı.txt", "turkish/İİİ.txt", "a b/c d.txt", "  leading/space.txt", "trailing space /x.txt",
  "tab\tname/x.txt", "nbsp dir/file.txt", "under_score/snake_case_name.py", "kebab-case/some-file-name.ts", "dot.dot/a.b.c.d",
  "CamelCase/SomeFileName.tsx", "UPPER/LOWER.TXT", "MiXeD/cAsE.Ts", "123/456/789.txt", "v1.2.3/release-notes.md", "#hash/@at/$dollar.txt",
  "x", "ab", "a/b", "a-b", "a.b", "a_b", "a b", ".hidden/.env.local", "src/index.ts", "src/index.test.ts", "src/indexer.ts",
  "packages/server/src/filesystem/search.ts", "packages/server/src/filesystem/search-cache.ts", "packages/ui/src/components/file-search.tsx",
]
const long = ["a".repeat(1000) + "/needle.txt", "deep/" + "segment/".repeat(150) + "target.txt", "x".repeat(998) + "yz"]
const pool = [...new Set([...realSample, ...realSample.map(p => p.toLowerCase()), ...unicode, ...unicode.map(p => p.toLowerCase()), ...long])]

const randomCase = s => [...s].map(c => random() < 0.3 ? c.toUpperCase() : c).join("")
const subsequence = s => { const chars = [...s]; const n = int(1, Math.min(8, chars.length)); const out = []; let i = 0; for (let k = 0; k < n && i < chars.length; k++) { i += int(0, Math.max(0, Math.floor((chars.length - i) / (n - k)) - 1)); out.push(chars[i++]) } return out.join("") }
const substring = s => { const chars = [...s]; const a = int(0, chars.length - 1); return chars.slice(a, a + int(1, 10)).join("") }
const segments = s => s.split(/[/._-]/).filter(Boolean)
const spaced = s => { const parts = segments(s); return Array.from({ length: int(2, 3) }, () => substring(pick(parts.length ? parts : [s]))).join(pick([" ", "  ", " \t", "  "])) }
const makeSearch = target => {
  const r = random()
  if (r < 0.2) return subsequence(target)
  if (r < 0.4) return substring(target)
  if (r < 0.5) return randomCase(substring(target))
  if (r < 0.65) return spaced(target)
  if (r < 0.72) return pick(segments(target).length ? segments(target) : [target])
  if (r < 0.78) return substring(target) + pick(["/", ".", "-", "_"]) + substring(pick(pool))
  if (r < 0.84) return pick(["zzqx", "qqq", "€", "😀", "ς", "Σ", "İ", "ß", "ss", "é", "e", "ı", "i̇", "/", ".", "-", "_", "ts", "src", "index", "farzher", "a a", "a b a", "  x  ", "\t", "x\ty"])
  if (r < 0.9) return spaced(pick(pool)) + " " + subsequence(target)
  return subsequence(pick(pool)) + subsequence(target)
}

const bits = n => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, n); return b.getBigUint64(0).toString(16).padStart(16, "0") }
const index = new Map(pool.map((p, i) => [p, i]))

const single = []
for (let i = 0; i < 4000; i++) {
  const target = pick(pool), search = random() < 0.85 ? makeSearch(target) : makeSearch(pick(pool))
  const r = fuzzysort.single(search, target)
  single.push([search, index.get(target), r ? bits(r.score) : null])
}

const go = []
for (let i = 0; i < 1200; i++) {
  const count = pick([1, 2, 5, 20, 60, 120, 250])
  const targets = Array.from({ length: count }, () => index.get(pick(pool)))
  // Duplicates and repeated scores exercise the heap's tie order.
  for (let d = 0; d < Math.floor(count / 5); d++) targets.splice(int(0, targets.length), 0, pick(targets))
  const search = makeSearch(pool[pick(targets)])
  const limit = pick([undefined, 0, 1, 2, 3, 5, 10, 100, 200])
  const objs = targets.map((t, i) => ({ key: pool[t], i }))
  const results = fuzzysort.go(search, objs, { key: "key", limit })
  go.push({ search, targets, limit: limit ?? null, results: results.map(r => [r.obj.i, bits(r.score)]) })
}

const matched = go.filter(c => c.results.length).length
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, "fuzzy-cases.json"), JSON.stringify({ version, pool, lower: pool.map(p => p.toLowerCase()), single, go }))
console.log(`pool ${pool.length}, single ${single.length} (${single.filter(s => s[2]).length} matched), go ${go.length} (${matched} with results)`)
