import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createHash, createPublicKey, verify } from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

export const targets = {
  "windows-x86_64": { directory: "nsis", extension: ".exe", name: "windows-x64" },
  "darwin-x86_64": { directory: "macos", extension: ".app.tar.gz", name: "macos-x64" },
  "darwin-aarch64": { directory: "macos", extension: ".app.tar.gz", name: "macos-arm64" },
  "linux-x86_64": { directory: "appimage", extension: ".AppImage", name: "linux-x64" },
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

// Validate both minisign signatures: artifact data and the trusted comment.
// Tauri uses minisign's prehashed Ed25519 format (ED); also accept Ed legacy data.
export function verifyArtifact(bytes, signature, publicKey) {
  const publicLines = Buffer.from(publicKey.trim(), "base64").toString("utf8").trim().split(/\r?\n/)
  const key = Buffer.from(publicLines[1] ?? "", "base64")
  const lines = Buffer.from(signature.trim(), "base64").toString("utf8").trim().split(/\r?\n/)
  const packet = Buffer.from(lines[1] ?? "", "base64")
  if (key.length !== 42 || packet.length !== 74 || key.subarray(0, 2).toString() !== "Ed"
      || !key.subarray(2, 10).equals(packet.subarray(2, 10)) || !lines[2]?.startsWith("trusted comment: ")) {
    throw new Error("Invalid minisign signature or mismatched signing key")
  }
  const algorithm = packet.subarray(0, 2).toString()
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error("Unsupported minisign signature algorithm")
  const ed25519 = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der", type: "spki",
  })
  const signed = packet.subarray(10)
  const payload = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes
  const comment = Buffer.from(lines[2].slice("trusted comment: ".length))
  if (!verify(null, payload, ed25519, signed)
      || !verify(null, Buffer.concat([signed, comment]), ed25519, Buffer.from(lines[3] ?? "", "base64"))) {
    throw new Error("Updater artifact signature verification failed")
  }
}

export function stageUpdater({ platform, version, bundleRoot, output, publicKey, repository, tag }) {
  const target = targets[platform]
  if (!target) throw new Error(`Unsupported updater target: ${platform}`)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid updater version")
  mkdirSync(output, { recursive: true })
  const fragment = { platform, version, signed: Boolean(publicKey?.trim()) }
  if (fragment.signed) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !tag) throw new Error("Signed publication requires repository and release tag")
    const directory = join(bundleRoot, target.directory)
    const candidates = readdirSync(directory).filter((file) => file.endsWith(target.extension))
    if (candidates.length !== 1) throw new Error(`Expected exactly one ${target.extension} updater artifact`)
    const source = join(directory, candidates[0])
    const bytes = readFileSync(source)
    const signature = readFileSync(`${source}.sig`, "utf8").trim()
    verifyArtifact(bytes, signature, publicKey)
    const asset = `CodeNomad-Tauri-${target.name}-${version}${target.extension}`
    copyFileSync(source, join(output, asset))
    writeFileSync(join(output, `${asset}.sig`), `${signature}\n`)
    Object.assign(fragment, {
      asset, sha256: sha256(bytes), signature,
      publicKeyHash: sha256(publicKey.trim()),
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`,
    })
  }
  writeFileSync(join(output, `${platform}.json`), `${JSON.stringify(fragment, null, 2)}\n`)
  return fragment
}

export function mergeUpdater(fragments, assets, { repository, tag }) {
  if (fragments.length !== Object.keys(targets).length) throw new Error("Missing updater platform fragments")
  const seen = new Set()
  for (const entry of fragments) {
    if (!targets[entry.platform] || seen.has(entry.platform)) throw new Error("Unknown or duplicate updater platform")
    seen.add(entry.platform)
  }
  if (new Set(fragments.map((entry) => entry.version)).size !== 1) throw new Error("Updater versions do not match")
  if (fragments.every((entry) => !entry.signed)) return null
  if (fragments.some((entry) => !entry.signed)) throw new Error("Cannot publish a partially signed update")
  if (new Set(fragments.map((entry) => entry.publicKeyHash)).size !== 1) throw new Error("Updater signing keys do not match")
  const platforms = {}
  for (const entry of fragments) {
    const target = targets[entry.platform]
    const expectedName = `CodeNomad-Tauri-${target.name}-${entry.version}${target.extension}`
    const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(expectedName)}`
    if (entry.asset !== expectedName || entry.url !== url || !entry.signature) throw new Error("Invalid updater asset identity")
    const artifact = assets.find((asset) => asset.name === entry.asset)
    const signature = assets.find((asset) => asset.name === `${entry.asset}.sig`)
    if (artifact?.digest !== `sha256:${entry.sha256}`
        || signature?.digest !== `sha256:${sha256(`${entry.signature}\n`)}`) {
      throw new Error(`Release artifact missing or different from signed build: ${entry.platform}`)
    }
    platforms[entry.platform] = { url, signature: entry.signature }
  }
  return { version: fragments[0].version, platforms }
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, argument] = process.argv.slice(2)
  const repository = process.env.GITHUB_REPOSITORY
  const tag = process.env.TAG
  if (mode === "stage") {
    const fragment = stageUpdater({
      platform: argument,
      version: JSON.parse(readFileSync(join(packageRoot, "src-tauri/tauri.conf.json"))).version,
      publicKey: process.env.TAURI_UPDATER_PUBKEY,
      bundleRoot: join(packageRoot, "target/release/bundle"),
      output: join(packageRoot, "release-updater"), repository, tag,
    })
    if (fragment.signed && process.env.UPDATER_UPLOAD === "true") {
      for (const asset of [fragment.asset, `${fragment.asset}.sig`]) {
        execFileSync("gh", ["release", "upload", tag, join(packageRoot, "release-updater", asset), "--repo", repository, "--clobber"], { stdio: "inherit" })
      }
    }
    console.log(`${argument}: ${fragment.signed ? "signature verified; updater artifact staged" : "unsigned build; updater disabled"}`)
  } else if (mode === "publish") {
    const fragments = readdirSync(argument).filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(argument, file))))
    const signed = fragments.some((entry) => entry.signed)
    const assets = signed ? JSON.parse(execFileSync("gh", ["api", `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`], { encoding: "utf8" })).assets : []
    const manifest = mergeUpdater(fragments, assets, { repository, tag })
    if (manifest) {
      const path = join(argument, "latest.json")
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
      execFileSync("gh", ["release", "upload", tag, path, "--repo", repository, "--clobber"], { stdio: "inherit" })
    } else {
      console.log("All platforms unsigned; no update manifest published")
    }
  } else {
    throw new Error(`Unknown updater artifact operation: ${mode}`)
  }
}
