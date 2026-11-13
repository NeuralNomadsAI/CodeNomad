import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { classifyCodeNomadLink, serverDisplayName } from "./codenomad-link"

test("raw credentials are rejected before destructive pairing normalization", () => {
  for (const value of ["https://user:secret@server.test/remote-pair#code", "https://user@server.test", "https://:secret@server.test/remote-pair#code", "https://@server.test"]) assert.equal(classifyCodeNomadLink(value), null)
  assert.equal(classifyCodeNomadLink("ftp://server.test"), null)
  assert.equal(classifyCodeNomadLink("https://server.test/remote-pair"), null)
  assert.deepEqual(classifyCodeNomadLink(" https://SERVER.test:443/path "), { kind: "address", baseUrl: "https://server.test" })
  assert.deepEqual(classifyCodeNomadLink("https://server.test/remote-pair#code"), { kind: "pairing", baseUrl: "https://server.test", entryUrl: "https://server.test/remote-pair#code" })
})
test("P2 host naming preserves explicit names and disambiguates ports", () => {
  const a = { id: "a", name: "example.test:444", baseUrl: "https://example.test:444" }
  assert.equal(serverDisplayName(a), "example.test")
  assert.equal(serverDisplayName(a, [a, { id: "b", name: "", baseUrl: "https://example.test:445" }]), "example.test:444")
  assert.equal(serverDisplayName({ ...a, name: "Build" }), "Build")
})
test("20 consumed messages match P2 in ten locales and four legacy values stay unchanged", () => {
  const snapshots: Record<string, [string, string]> = {
    "en": ["7f472d66d82b686a2ba2a52b888fc614437f2802b9ad395e5ea914e05e807b3b", "f4611f6dc68e5530d23c4ef6f6449c0997ddee3d8f63260095032ba4160346e7"],
    "fr": ["1dd8c4b3d9e0c4946f3aff3e5cd97f9e4a8588be4934d7322f169f0b40cc4dfc", "976b44d1586371a336060266db5ddcd74d79fbb886780d8b22533ecca837e0a1"],
    "de": ["a8c2583fdfebc81c579df4f3356451d3084812305db1f4f2f95bfb99f9d6e67d", "b20582c8387f84dc310581d7c6dc123d5f3101a4d4ade6d6260ab4e55a0421b4"],
    "es": ["0c0ead3e71901cd2133218df2e128dad36acf7a07c70978dee479919b4a753dd", "71829f6ba7e77692ab97559f8aa50b55de73f94e1724c69d9bcc8f76d6e5f1b5"],
    "he": ["c2d87eadd1acd0c1b5e2370017b9b0a6d3681258f81120275eb5766dae34e280", "617309fea5d90cf6a7b311a2fc9e686a49c4e8de6d792b833d43bb593d09d84b"],
    "ja": ["8d3d13a01f3e8e7a8449134cf42c285ee1d40f3f89486eb7ae12f9178f28b4c0", "4282d48422241b437cf7504e5b1781dc5f0991420d6cb523789c0dfcef3856b6"],
    "ne": ["58854e2eab7b85140980c7ce0f06c9accd9ef07fe4501361df745f43e0b623d8", "95a2708bee7ebe431bfdd0d73eecd83555abccd9c327eda855ac77bae0af35c0"],
    "ru": ["4e60fdf220de0ac6b142703b35cbca539b8d32bede259a3ee40a914e779c02dc", "fa0de9613068f7abad200ed7add520ad6911f1d5e434570999c29f011ce1d2a5"],
    "tr": ["dfdb55e2cd47953eef43abc6e8475f4274c2d91f27913ec534831aa039757aa0", "4c711c7dd4b1d9ba2aaa2b037f36363ec913ea83f8d0a732b890fb401d948284"],
    "zh-Hans": ["7cb98c2b0821f01b232e31b5c007e1377094c381ac3f7a11e9fead0938e02874", "a8cb86e520f64182ce044995a33057ac4996bb23f94a20c30db33ae5c5211039"],
  }
  const hash = (values: unknown[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex")
  for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const directory = new URL(`./i18n/messages/${locale}/`, import.meta.url)
    const read = (text: string) => new Map([...text.matchAll(/"([\w.]+)":\s*("(?:[^"\\]|\\.)*"),/g)].map(m => [m[1], JSON.parse(m[2])]))
    const current = read(readFileSync(new URL("folderSelection.ts", directory), "utf8") + readFileSync(new URL("settings.ts", directory), "utf8"))
    const variants = ["name", "url", "skipTls", "errorRequired"]
    const keys = [...current.keys()].filter(key => /^(remoteBrowse\.|folderSelection\.browseMenu\.|folderSelection\.remoteProject\.)/.test(key)).sort()
      .concat(["settings.nav.servers", "settings.servers.open", ...variants.map(key => `settings.servers.dialog.${key}`)])
    assert.equal(keys.length, 20)
    assert(keys.every(key => typeof current.get(key) === "string"))
    assert.equal(hash(keys.map(key => current.get(key))), snapshots[locale][0], `${locale}/P2`)
    assert.equal(hash(variants.map(key => current.get(`folderSelection.servers.dialog.${key}`))), snapshots[locale][1], `${locale}/legacy`)
    for (const key of ["sshHost", "sshHint"]) assert.ok(current.get(`folderSelection.servers.dialog.${key}`)?.trim(), `${locale}/SSH ${key}`)
  }
})
