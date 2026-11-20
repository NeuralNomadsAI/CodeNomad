// Parity cases for the file search query parser: each raw query string goes through Fastify's parser
// (fast-querystring) and the TS `WorkspaceFileSearchQuerySchema` (zod): the parsed value or the exact
// error message (the 400 body's `error`) is recorded.
//   node generate-search-query-cases.mjs [output folder]   (default tests/fixtures)
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../../../", import.meta.url))
const out = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../tests/fixtures"))
const require = createRequire(path.join(repo, "packages/server/package.json"))
const { z } = require("zod")
const parse = createRequire(require.resolve("fastify/package.json"))("fast-querystring").parse

// Copied from packages/server/src/server/routes/workspaces.ts (module-private).
const WorkspaceFileSearchQuerySchema = z.object({
  directory: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1, "Query is required"),
  limit: z.coerce.number().int().positive().max(200).optional(),
  type: z.enum(["all", "file", "directory"]).optional(),
  refresh: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
})

const e = encodeURIComponent
const limits = ["", " ", "0", "-0", "1", "2", "199", "200", "201", "-1", "1.5", "-1.5", "1e2", "1e3", "2e-1", "1e300", "-1e300", "9007199254740991",
  "9007199254740992", "9007199254740993", "-9007199254740992", "abc", "0x10", "0X1f", "0b11", "0o7", "0x", "+0x10", "-0x10", "Infinity", "-Infinity", "+Infinity",
  "infinity", "NaN", " 5 ", "\t5\n", " 5", "﻿5", "\u00855", "5abc", "+5", ".5", "5.", "1_000", "١", "00012", "1.0", "0.0", "1e", "e5", "--1", "0x1.8",
  "0xFFFFFFFFFFFFFFFFFFFF", "1,2", "100%", "%31%30"]
const raw = new Set([
  "", "q=", "q", "q=%20", "q=+", "q=%09%0A", "q=%C2%A0", "q=%EF%BB%BF", "q=%C2%85", "q=a", "q=a&q=b", "q=a&q=b&q=c", "q=%zz", "q=a%zz%41", "q=%41",
  "q=%E2%82%AC", "q=%C0%80", "q=%ED%A0%80", "q=a+b", "q=a%2Bb", "q=%", "q=a=b", "q==a", "=x&q=a", "&&q=a&&", "q=x&unknown=1", "Q=a", "q%3D=a", "q[]=a",
  "directory=&q=a", "directory=%20&q=a", "directory=x&directory=y&q=a", "directory=x&directory=y", "directory=x", "directory=%20x%20&q=a",
  "q=a&type=all", "q=a&type=file", "q=a&type=directory", "q=a&type=File", "q=a&type=", "q=a&type=x&type=y", "q=a&type=file&type=file",
  "q=a&refresh=true", "q=a&refresh=TRUE", "q=a&refresh=1", "q=a&refresh=", "q=a&refresh", "q=a&refresh=true&refresh=true", "refresh=x&refresh=y",
  "limit=abc", "limit=0&type=x&refresh=a&refresh=b&directory=", "q=%20&limit=1.5&type=", "directory=a&directory=b&q=&limit=-1&type=no&refresh=1&refresh=2",
  ...limits.map(l => `q=a&limit=${e(l)}`), ...limits.slice(0, 12).map(l => `limit=${e(l)}`), "q=a&limit=1&limit=2", "q=a&limit=5&limit=5",
  "q=a&limit=", "q=a&limit", "q=%E2%80%A8x%E2%80%A9", "q=%E3%80%80", "q=farzher", "q=%F0%9F%98%80", "q=%F0%9F%98", "q=%FF",
])
const cases = [...raw].map(query => {
  const parsed = WorkspaceFileSearchQuerySchema.safeParse(parse(query))
  return parsed.success ? { query, ok: parsed.data } : { query, error: parsed.error.message }
})
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, "search-query-cases.json"), JSON.stringify(cases, null, 1))
console.log(`${cases.length} cases, ${cases.filter(c => c.error).length} refused`)
