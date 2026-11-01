import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { integrationCatalogSchema } from "./contract"

/** Test-only immutable OI catalog: revision 54d6e5d0f4c22e74d228822fcaaa0912818a8b46, catalog.json. */
export function pinnedBlenderCatalog() {
  // Normalize Git's Windows checkout line endings before comparing the original blob.
  const text = readFileSync(new URL("./fixtures/catalog-54d6e5d.json", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  assert.equal(createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex"),
    "752451bff8d9e3779b8dbf3087cca2ab16492804")
  return integrationCatalogSchema.parse(JSON.parse(text))
}
