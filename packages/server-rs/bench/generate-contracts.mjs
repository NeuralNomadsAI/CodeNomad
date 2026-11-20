// JSON Schemas of the session-history RPC and pending-request contracts, from the built TS server, in contracts/
// (or [output folder]). The generator refuses keywords outside the dialect the Rust validator supports.
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { dist, fromDist, repo } from "./fixtures.mjs"

const z = createRequire(path.join(repo, "packages/server/package.json"))("zod")
const out = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../contracts"))
const nav = await fromDist("opencode/session-pruning/navigation-contract.js")
const schemas = {
  "outline-input": nav.outlineInputSchema, "outline-output": nav.outlineLayoutResultSchema,
  "outlinePreview-input": nav.outlinePreviewInputSchema, "outlinePreview-output": nav.outlinePreviewResultSchema,
  "window-input": nav.navigationWindowInputSchema, "window-output": nav.navigationWindowResultSchema,
}
const pending = await readFile(new URL("server/routes/pending-requests.js", dist), "utf8")
const first = pending.indexOf("const directorySchema")
const last = pending.indexOf("const unavailableSchema")
if (first < 0 || last <= first) throw Error("Unexpected pending-request schema source")
schemas.pending = new Function("z", `${pending.slice(first, last)}\nreturn nativeSchema`)(z)
await mkdir(out, { recursive: true })
for (const [name, schema] of Object.entries(schemas)) {
  const encoded = z.toJSONSchema(schema, { io: name === "pending" ? "output" : undefined })
  function check(node) {
    if (typeof node === "boolean") return
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties") Object.values(value).forEach(check)
      else if (["items", "propertyNames", "additionalProperties"].includes(key)) check(value)
      else if (["anyOf", "oneOf"].includes(key)) value.forEach(check)
      else if (key === "pattern") {
        if (!["^[a-f0-9]{64}$", "^(?:[RTX]{0,1000}|[RTX]{0,500}-[RTX]{0,500})$"].includes(value)) throw Error(`Unsupported pattern in ${name}`)
      } else if (!["$schema", "type", "minLength", "maxLength", "minimum", "maximum", "required", "maxItems", "minItems", "const", "enum"].includes(key)) {
        throw Error(`Unsupported keyword ${key} in ${name}`)
      }
    }
  }
  check(encoded)
  await writeFile(path.join(out, `${name}.json`), `${JSON.stringify(encoded, null, 2)}\n`)
}
console.log(out)
