import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const root = path.resolve(__dirname, "..")
const repoRoot = path.resolve(root, "..", "..")

const r2Bucket = process.env.CODENOMAD_R2_BUCKET

if (!r2Bucket) {
  console.error("Missing env var: CODENOMAD_R2_BUCKET")
  process.exit(1)
}

const uiPackageJsonPath = path.join(repoRoot, "packages/ui/package.json")
const uiPackageJson = JSON.parse(fs.readFileSync(uiPackageJsonPath, "utf-8"))
const uiVersion = uiPackageJson.version

if (!uiVersion) {
  console.error("Missing packages/ui/package.json version")
  process.exit(1)
}

const uiBuildDir = path.join(repoRoot, "packages/ui/src/renderer/dist")
if (!fs.existsSync(uiBuildDir)) {
  console.error(`Missing UI build dir: ${uiBuildDir}. Run UI build first.`)
  process.exit(1)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-ui-release-"))
const zipPath = path.join(tmpDir, `ui-${uiVersion}.zip`)

try {
  // Zip the CONTENTS of the dist dir (so index.html is at zip root).
  execFileSync("/usr/bin/zip", ["-q", "-r", zipPath, "."], { cwd: uiBuildDir, stdio: "inherit" })

  // Upload to R2.
  const objectKey = `ui/ui-${uiVersion}.zip`
  console.log(`[release-ui] Uploading ${zipPath} -> r2://${r2Bucket}/${objectKey}`)

  execFileSync(
    "npx",
    ["wrangler", "r2", "object", "put", "--remote", `${r2Bucket}/${objectKey}`, "--file", zipPath],
    { cwd: root, stdio: "inherit" },
  )

  // Generate version.json into packages/cloudflare/dist
  console.log("[release-ui] Generating version.json")
  execFileSync(
    process.execPath,
    [path.join(root, "scripts/build-manifest.mjs"), "--zip", zipPath],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        CODENOMAD_R2_BUCKET: r2Bucket,
      },
    },
  )

  console.log("[release-ui] Deploying worker")
  execFileSync("npx", ["wrangler", "deploy"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    },
  })

  console.log("[release-ui] Done")
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
