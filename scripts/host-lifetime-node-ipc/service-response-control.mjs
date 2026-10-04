// Scoped private probe: no builds, global source hash, product host or user daemon.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readdir, rmdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { addonConfig } from "./addon-config.mjs"
const repo = fileURLToPath(new URL("../../", import.meta.url))
const ownsRoot = !process.argv[2]
const root = process.argv[2] ?? await mkdtemp(path.join(process.env.LOCALAPPDATA, "Temp", "opencode", "service-response-"))
const proofs = []
let stage = "configuration"
try {
  for (const fault of ["healthy", "malformed-peer", "unknown-peer-id", "unknown-completion", "invalid-receipt", "peer-loss", "unconfirmed-failure", "wrong-peer-scope", "oversize-output"]) {
    stage = fault
    const { config, dispose } = await addonConfig(root, "service-response", fault)
    try {
      const data = Buffer.from(JSON.stringify(config)), size = Buffer.alloc(4); size.writeUInt32LE(data.length)
      assert.ok(data.length <= 4000)
      const result = spawnSync(path.join(repo, "packages/native-host-lifetime/target/debug/host-lifetime-fixture.exe"), ["supervisor-service-response"], {
        cwd: repo, env: process.env, shell: false, windowsHide: true, input: Buffer.concat([size, data]), encoding: "utf8", timeout: 30000, maxBuffer: 8192,
      })
      if (result.error || result.status !== 0 || result.stderr) {
        // Fixture executable reports static native codes only. Never print raw
        // manager/starter output, environment or native channel bytes.
        const code = /^native-[a-z-]+\s*$/.test(result.stderr ?? "") ? result.stderr.trim() : "native-response-probe-failed"
        throw new Error(code)
      }
      const proof = JSON.parse(result.stdout)
      assert.equal(proof.sameProductionCompletionWriter, true)
      assert.equal(proof.managerAndBackendExitConfirmed, true)
      assert.equal(proof.productManagerQualified, false)
      if (fault === "healthy") { assert.equal(proof.correlatedFailurePreservesManagerBackend, true); assert.equal(proof.subsequentServiceSuccess, true) }
      else assert.equal(proof.fatalFaultClosesRuntimeJob, true)
      proofs.push(proof)
    } finally { await dispose() }
  }
  console.log(JSON.stringify({ outcome: "PASSED_NARROW_SERVICE_RESPONSE_PROOF", cases: proofs, productQualified: false }))
} catch (error) {
  const code = error instanceof Error && /^native-[a-z-]+$/.test(error.message) ? error.message : "native-response-probe-failed"
  console.error(`${code}-${stage}`); process.exitCode = 1
}
finally { if (ownsRoot) { assert.deepEqual(await readdir(root), []); await rmdir(root) } }
