// Fixture-only: record allowlisted facts, never argv, credentials or arbitrary env.
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { fileURLToPath } = require("node:url")

module.exports = function emit(kind, directory, context, moduleIdentity) {
  const root = process.env.NATIVE_STARTUP_ROOT
  const nonce = process.env.NATIVE_STARTUP_NONCE
  const marker = process.env.NATIVE_STARTUP_MARKER
  if (!root || !path.isAbsolute(root) || !/^[a-f0-9-]{36}$/.test(nonce || "")) throw new Error("Fixture isolation missing")
  const relative = path.relative(path.join(root, "markers"), marker || "")
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Fixture marker outside owned root")
  const entry = { kind, nonce, pid: process.pid, ppid: process.ppid, execPath: process.execPath,
    nodeVersion: process.version, bunVersion: process.versions.bun ?? null,
    phase: process.env.NATIVE_STARTUP_PHASE,
    persistedNonce: process.env.NATIVE_STARTUP_PERSISTED_NONCE ?? null,
    nodeOptionsHash: crypto.createHash("sha256").update(process.env.NODE_OPTIONS || "").digest("hex"),
    bunOptionsHash: crypto.createHash("sha256").update(process.env.BUN_OPTIONS || "").digest("hex"),
    fixtureRoot: root, stateRoot: process.env.XDG_STATE_HOME, configRoot: process.env.OPENCODE_CONFIG_DIR,
    database: process.env.OPENCODE_DB,
    at: Date.now(), ...(directory ? { directory } : {}),
    ...(context ? { sessionID: context.sessionID, messageID: context.messageID, callID: context.id } : {}),
    ...(moduleIdentity ? { moduleURL: moduleIdentity.moduleURL, moduleSHA256: moduleIdentity.moduleSHA256,
      sourceFingerprintSHA256: moduleIdentity.sourceFingerprintSHA256 } : {}) }
  fs.appendFileSync(marker, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}

// Observation only: no enrollment, timer, authority or native service is created by import.
module.exports.module = function emitModule(kind, moduleURL) {
  const fixture = path.join(process.env.NATIVE_STARTUP_ROOT, "fixture")
  const file = fs.realpathSync(fileURLToPath(moduleURL))
  const relative = path.relative(fixture, file)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Module outside private fixture")
  const fingerprint = path.join(fixture, "module-fingerprints.json")
  if (fs.statSync(file).size > 8 * 1024 * 1024 || fs.statSync(fingerprint).size > 16 * 1024) throw new Error("Module proof too large")
  const sha256 = value => crypto.createHash("sha256").update(value).digest("hex")
  module.exports(kind, undefined, undefined, { moduleURL, moduleSHA256: sha256(fs.readFileSync(file)),
    sourceFingerprintSHA256: sha256(fs.readFileSync(fingerprint)) })
}
