// Run with: node --import tsx scripts/test-opencode-legacy-replacement-native.mjs
// Real npm and published packages in an isolated home/prefix/cache. Never touches
// the user's npm prefix, PATH, OpenCode installation or shared daemon.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"
import { installSharedOpenCode, npmCommandDirectory, npmExecutable, resolveDefaultInstallation, sharedInstallationPlan } from "../packages/server/src/opencode-update/shared-installation.ts"
import { legacyNativeImages, legacyNpmPackageRoot } from "../packages/server/src/opencode-update/legacy-installation.ts"
import { bundledNpm } from "../packages/server/src/opencode-update/npm-runtime.ts"
import { RECOMMENDED_OPENCODE_VERSION } from "../packages/server/src/opencode/runtime-support.ts"

const LEGACY_VERSION = process.env.CODENOMAD_FIXTURE_LEGACY_VERSION || "1.18.10"
const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-legacy-replacement-"))
const node = process.env.CODENOMAD_FIXTURE_NODE || process.execPath
const npm = bundledNpm(node)
assert.ok(npm, "npm must be bundled beside the selected Node")
const prefix = path.join(root, "npm prefix")
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(OPENCODE_|CODENOMAD_|CLI_|XDG_|npm_|PATH$|NODE_|ELECTRON_|WEBVIEW2_)/i.test(key)))
Object.assign(env, {
  HOME: root, USERPROFILE: root, APPDATA: path.join(root, "AppData"), LOCALAPPDATA: path.join(root, "LocalAppData"),
  XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"), npm_config_prefix: prefix, npm_config_cache: path.join(root, "npm-cache"),
  npm_config_userconfig: path.join(root, "npmrc"),
  // The user's PC: the npm prefix holding OpenCode 1.x is on PATH.
  PATH: [npmCommandDirectory(prefix), path.dirname(node), ...(process.platform === "win32" ? [`${process.env.SystemRoot}/System32`] : ["/usr/bin", "/bin"])].join(path.delimiter),
})
for (const key of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) await mkdir(env[key], { recursive: true })
const run = (args) => promisify(execFile)(node, [npm, ...args], { cwd: root, env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
const options = { home: root, env, node, npm, registerPath: async () => {} }
const result = { root, legacyVersion: LEGACY_VERSION, target: RECOMMENDED_OPENCODE_VERSION }
try {
  await run(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org", `opencode-ai@${LEGACY_VERSION}`])
  const plan = sharedInstallationPlan(options)
  assert.equal(plan.prefix, prefix)
  assert.equal(plan.legacy?.version, LEGACY_VERSION, "the published 1.x shim is recognized from its manifest and target")
  result.legacyCommand = plan.legacy.command

  // Fact check: npm refuses to link @opencode/cli's `opencode` bin over the 1.x shim.
  const collision = await run(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org",
    `@opencode/cli@${RECOMMENDED_OPENCODE_VERSION}`]).then(() => undefined, error => `${error.stderr ?? error.message}`)
  assert.ok(collision && /EEXIST/.test(collision), "plain npm installation collides with the 1.x shim")
  result.collision = collision.split(/\r?\n/).find(line => /EEXIST/.test(line))
  assert.equal(sharedInstallationPlan(options).legacy?.version, LEGACY_VERSION, "the failed plain install left 1.x in place")

  await assert.rejects(installSharedOpenCode(RECOMMENDED_OPENCODE_VERSION, options), /explicit confirmation/)
  assert.ok(existsSync(legacyNpmPackageRoot(prefix, process.platform)))

  result.nativeImages = legacyNativeImages(legacyNpmPackageRoot(prefix, process.platform)).map(image => path.relative(prefix, image))
  assert.ok(result.nativeImages.some(image => /\.exe$|[\\/]\.opencode$/.test(image)), "the package's native executable is preflighted")
  const consent = { path: plan.legacy.command, version: LEGACY_VERSION }
  await assert.rejects(installSharedOpenCode(RECOMMENDED_OPENCODE_VERSION, { ...options, replaceLegacy: { ...consent, version: "1.0.0" } }), /explicit confirmation/)
  assert.equal(await installSharedOpenCode(RECOMMENDED_OPENCODE_VERSION, { ...options, replaceLegacy: consent }), npmExecutable(prefix))
  assert.equal(existsSync(legacyNpmPackageRoot(prefix, process.platform)), false)
  assert.deepEqual(sharedInstallationPlan(options), { prefix })
  const resolved = resolveDefaultInstallation(options)
  assert.equal(resolved.source, "path")
  const version = (await promisify(execFile)(npmExecutable(prefix), ["--version"], { cwd: root, env, timeout: 60_000, windowsHide: true })).stdout.trim()
  assert.equal(version.replace(/^opencode2? v?/, ""), RECOMMENDED_OPENCODE_VERSION)
  result.resolved = resolved
  result.success = true
} finally {
  await writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
