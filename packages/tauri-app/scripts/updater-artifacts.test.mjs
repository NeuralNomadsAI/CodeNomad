import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeUpdater, stageUpdater, targets, verifyArtifact } from "./updater-artifacts.mjs"

const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const keyId = randomBytes(8)
const publicBytes = publicKey.export({ type: "spki", format: "der" }).subarray(-32)
const encodedKey = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), keyId, publicBytes]).toString("base64")}\n`).toString("base64")
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const release = { repository: "owner/project", tag: "v1.2.3" }

function signature(bytes, algorithm = "ED") {
  const message = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes
  const signed = sign(null, message, privateKey)
  const comment = "timestamp:12345\tfile:fixture\tversion:1.2.3"
  const packet = Buffer.concat([Buffer.from(algorithm), keyId, signed]).toString("base64")
  const global = sign(null, Buffer.concat([signed, Buffer.from(comment)]), privateKey).toString("base64")
  return Buffer.from(`untrusted comment: fixture\n${packet}\ntrusted comment: ${comment}\n${global}\n`).toString("base64")
}

test("verifies artifact and trusted-comment signatures; rejects tampering and wrong keys", () => {
  const bytes = Buffer.from("installer fixture")
  for (const algorithm of ["Ed", "ED"]) {
    const encoded = signature(bytes, algorithm)
    verifyArtifact(bytes, encoded, encodedKey)
    assert.throws(() => verifyArtifact(Buffer.from("changed"), encoded, encodedKey), /verification failed/)
    const tampered = Buffer.from(Buffer.from(encoded, "base64").toString().replace("version:1.2.3", "version:9.9.9")).toString("base64")
    assert.throws(() => verifyArtifact(bytes, tampered, encodedKey), /verification failed/)
    const other = Buffer.from(encodedKey, "base64").toString().split("\n")
    const key = Buffer.from(other[1], "base64")
    key[2] ^= 1
    other[1] = key.toString("base64")
    assert.throws(() => verifyArtifact(bytes, encoded, Buffer.from(other.join("\n")).toString("base64")), /mismatched/)
  }
})

test("stages all native artifact formats and publishes only a complete verified release", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "updater-artifacts-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const fragments = []
  const assets = []
  for (const [platform, target] of Object.entries(targets)) {
    const root = join(directory, platform)
    const bundleRoot = join(root, "bundle")
    const output = join(root, "out")
    mkdirSync(join(bundleRoot, target.directory), { recursive: true })
    const source = join(bundleRoot, target.directory, `original${target.extension}`)
    const bytes = Buffer.from(`fixture-${platform}`)
    writeFileSync(source, bytes)
    writeFileSync(`${source}.sig`, signature(bytes))
    const entry = stageUpdater({ platform, version: "1.2.3", bundleRoot, output, publicKey: encodedKey, ...release })
    assert.deepEqual(readFileSync(join(output, entry.asset)), bytes)
    assert.equal(JSON.parse(readFileSync(join(output, `${platform}.json`))).signature, signature(bytes))
    fragments.push(entry)
    assets.push({ name: entry.asset, digest: `sha256:${digest(bytes)}` })
    assets.push({ name: `${entry.asset}.sig`, digest: `sha256:${digest(`${entry.signature}\n`)}` })
  }
  const result = mergeUpdater(fragments, assets, release)
  assert.equal(result.version, "1.2.3")
  assert.deepEqual(Object.keys(result.platforms).sort(), Object.keys(targets).sort())
  assert.match(result.platforms["windows-x86_64"].url, /\.exe$/)
  assert.match(result.platforms["darwin-aarch64"].url, /\.app\.tar\.gz$/)
  assert.throws(() => mergeUpdater(fragments.slice(1), assets, release), /Missing/)
  assert.throws(() => mergeUpdater([fragments[0], ...fragments.slice(0, 3)], assets, release), /duplicate/)
  assert.throws(() => mergeUpdater(fragments.map((f, i) => i === 0 ? { ...f, version: "2.0.0" } : f), assets, release), /versions/)
  assert.throws(() => mergeUpdater(fragments.map((f, i) => i === 0 ? { ...f, signed: false } : f), assets, release), /partially/)
  assert.throws(() => mergeUpdater(fragments.map((f, i) => i === 0 ? { ...f, publicKeyHash: "other" } : f), assets, release), /keys/)
  assert.throws(() => mergeUpdater(fragments, assets.slice(1), release), /missing/)
  assert.throws(() => mergeUpdater(fragments, assets.map((a, i) => i === 0 ? { ...a, digest: "sha256:stale" } : a), release), /different/)
  assert.throws(() => mergeUpdater(fragments, assets, { ...release, tag: "another-release" }), /identity/)
})

test("unsigned builds record every platform but never publish a manifest or use stale signed assets", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "updater-unsigned-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const fragments = Object.keys(targets).map((platform) => stageUpdater({
    platform, version: "1.2.3", publicKey: "", bundleRoot: "does-not-exist", output: directory,
  }))
  assert.equal(mergeUpdater(fragments, [], release), null)
})
