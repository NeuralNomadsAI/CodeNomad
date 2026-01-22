import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const root = path.resolve(__dirname, "..")
const repoRoot = path.resolve(root, "..", "..")

const releaseConfigPath = path.join(root, "release-config.json")
const uiPackageJsonPath = path.join(repoRoot, "packages/ui/package.json")
const serverPackageJsonPath = path.join(repoRoot, "packages/server/package.json")

const distDir = path.join(root, "dist")
const manifestPath = path.join(distDir, "version.json")

const args = new Set(process.argv.slice(2))

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return null
  return process.argv[idx + 1] ?? null
}

const zipPath = getArgValue("--zip")

if (!zipPath) {
  console.error("Usage: node scripts/build-manifest.mjs --zip <path-to-ui-zip>")
  process.exit(1)
}

const resolvedZipPath = path.resolve(process.cwd(), zipPath)
if (!fs.existsSync(resolvedZipPath)) {
  console.error(`Zip not found: ${resolvedZipPath}`)
  process.exit(1)
}

const releaseConfig = JSON.parse(fs.readFileSync(releaseConfigPath, "utf-8"))
const uiPackageJson = JSON.parse(fs.readFileSync(uiPackageJsonPath, "utf-8"))
const serverPackageJson = JSON.parse(fs.readFileSync(serverPackageJsonPath, "utf-8"))

const bucket = process.env.CODENOMAD_R2_BUCKET

if (!bucket) {
  console.error("Missing env var: CODENOMAD_R2_BUCKET")
  process.exit(1)
}

const uiVersion = uiPackageJson.version
const serverVersion = serverPackageJson.version

if (!uiVersion || !serverVersion) {
  console.error("Missing version fields in package.json")
  process.exit(1)
}

const sha256 = createHash("sha256").update(fs.readFileSync(resolvedZipPath)).digest("hex")

const uiPackageURL = `https://download.codenomad.neuralnomads.ai/ui/ui-${uiVersion}.zip`

const manifest = {
  minServerVersion: releaseConfig.minServerVersion,
  latestUIVersion: uiVersion,
  uiPackageURL,
  sha256,
  latestServerVersion: serverVersion,
  latestServerUrl: releaseConfig.latestServerUrl,
}

fs.mkdirSync(distDir, { recursive: true })
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8")

const headersPath = path.join(distDir, "_headers")
fs.writeFileSync(
  headersPath,
  "/version.json\n  Cache-Control: no-cache\n  Content-Type: application/json; charset=utf-8\n",
  "utf-8",
)

console.log(`Wrote ${manifestPath}`)
console.log(`Wrote ${headersPath}`)
