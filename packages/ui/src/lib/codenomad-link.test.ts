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
test("host naming preserves explicit names and disambiguates ports", () => {
  const a = { id: "a", name: "example.test:444", baseUrl: "https://example.test:444" }
  assert.equal(serverDisplayName(a), "example.test")
  assert.equal(serverDisplayName(a, [a, { id: "b", name: "", baseUrl: "https://example.test:445" }]), "example.test:444")
  assert.equal(serverDisplayName({ ...a, name: "Build" }), "Build")
})
test("server editor and separate-window labels retain their translations in ten locales", () => {
  const snapshots: Record<string, [string, string]> = {
    "en": ["7f472d66d82b686a2ba2a52b888fc614437f2802b9ad395e5ea914e05e807b3b", "f4611f6dc68e5530d23c4ef6f6449c0997ddee3d8f63260095032ba4160346e7"],
    "fr": ["28f05ebf100e29f2da9a9fced0acff7a6c62edec4b63e7e22a673153a085f208", "976b44d1586371a336060266db5ddcd74d79fbb886780d8b22533ecca837e0a1"],
    "de": ["89fe20edf137af7c7e36cd1aa23351ceec1e3c1b05d23249cd3d4b1ba9a8931d", "b20582c8387f84dc310581d7c6dc123d5f3101a4d4ade6d6260ab4e55a0421b4"],
    "es": ["d4163f9e4fb717be6772517fe0b8d9af894c8e3173a18bccf0f0a71373df278e", "71829f6ba7e77692ab97559f8aa50b55de73f94e1724c69d9bcc8f76d6e5f1b5"],
    "he": ["c2d87eadd1acd0c1b5e2370017b9b0a6d3681258f81120275eb5766dae34e280", "617309fea5d90cf6a7b311a2fc9e686a49c4e8de6d792b833d43bb593d09d84b"],
    "ja": ["8d3d13a01f3e8e7a8449134cf42c285ee1d40f3f89486eb7ae12f9178f28b4c0", "4282d48422241b437cf7504e5b1781dc5f0991420d6cb523789c0dfcef3856b6"],
    "ne": ["87af087382e917a89c291027e543dd3744caffce2bdff4570118218d6a4c31c1", "95a2708bee7ebe431bfdd0d73eecd83555abccd9c327eda855ac77bae0af35c0"],
    "ru": ["4e60fdf220de0ac6b142703b35cbca539b8d32bede259a3ee40a914e779c02dc", "fa0de9613068f7abad200ed7add520ad6911f1d5e434570999c29f011ce1d2a5"],
    "tr": ["dfdb55e2cd47953eef43abc6e8475f4274c2d91f27913ec534831aa039757aa0", "4c711c7dd4b1d9ba2aaa2b037f36363ec913ea83f8d0a732b890fb401d948284"],
    "zh-Hans": ["7cb98c2b0821f01b232e31b5c007e1377094c381ac3f7a11e9fead0938e02874", "a8cb86e520f64182ce044995a33057ac4996bb23f94a20c30db33ae5c5211039"],
  }
  const hash = (values: unknown[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex")
  for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const directory = new URL(`./i18n/messages/${locale}/`, import.meta.url)
    const read = (text: string) => new Map([...text.matchAll(/"([\w.]+)":\s*("(?:[^"\\]|\\.)*"),/g)].map(m => [m[1], JSON.parse(m[2])]))
    const current = read(readFileSync(new URL("folderSelection.ts", directory), "utf8") + readFileSync(new URL("settings.ts", directory), "utf8"))
    const restore = read(readFileSync(new URL("dialogs.ts", directory), "utf8"))
    assert.ok(restore.get("remoteRestore.absent")?.trim(), `${locale}/missing saved server`)
    const variants = ["name", "url", "skipTls", "errorRequired"]
    const keys = [
      "folderSelection.browseMenu.add", "folderSelection.browseMenu.addField", "folderSelection.browseMenu.errorCredentials",
      "folderSelection.browseMenu.errorInvalid", "folderSelection.browseMenu.skipTls", "folderSelection.remoteProject.edit",
      "folderSelection.remoteProject.removeConfirm", "remoteBrowse.pairAgain", "remoteBrowse.pairingExpired", "remoteBrowse.pairingLink",
      "remoteBrowse.pairingRateLimited", "remoteBrowse.pairingUnavailable", "remoteBrowse.tlsError", "remoteBrowse.unreachable",
      "settings.nav.servers", "settings.servers.open", ...variants.map(key => `settings.servers.dialog.${key}`),
    ]
    assert.ok(current.get("remoteBrowse.incompatible")?.trim(), `${locale}/incompatible server`)
    assert(keys.every(key => typeof current.get(key) === "string"))
    assert.equal(hash(keys.map(key => current.get(key))), snapshots[locale][0], `${locale}/server editor`)
    assert.equal(hash(variants.map(key => current.get(`folderSelection.servers.dialog.${key}`))), snapshots[locale][1], `${locale}/separate window`)
    for (const key of ["sshHost", "sshHint"]) assert.ok(current.get(`folderSelection.servers.dialog.${key}`)?.trim(), `${locale}/SSH ${key}`)
  }
})
