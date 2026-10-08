import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { it } from "node:test"
import { fileURLToPath } from "node:url"
import forge from "node-forge"

// Trust only a disposable fixture CA in a child process: neither the parent nor
// the user's trust store, cookies, settings, or running daemon are modified.
it("isolates preview credentials and verifies HTTP/WebSocket TLS on real upstreams", { timeout: 120_000 }, async () => {
  const tempRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode")
    : process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"
  fs.mkdirSync(tempRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tempRoot, "preview-security-"))
  try {
    const caKeys = forge.pki.rsa.generateKeyPair(2048)
    const ca = forge.pki.createCertificate()
    ca.publicKey = caKeys.publicKey
    ca.serialNumber = "01"
    ca.validity.notBefore = new Date("2020-01-01T00:00:00Z")
    ca.validity.notAfter = new Date("2040-01-01T00:00:00Z")
    ca.setSubject([{ name: "commonName", value: "Disposable preview test CA" }])
    ca.setIssuer(ca.subject.attributes)
    ca.setExtensions([{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true }])
    ca.sign(caKeys.privateKey, forge.md.sha256.create())
    fs.writeFileSync(path.join(directory, "ca.pem"), forge.pki.certificateToPem(ca))

    const keys = forge.pki.rsa.generateKeyPair(2048)
    const fixtures = Object.fromEntries(["valid", "expired", "mismatched", "untrusted"].map((kind, index) => {
      const cert = forge.pki.createCertificate()
      cert.publicKey = keys.publicKey
      cert.serialNumber = `0${index + 2}`
      cert.validity.notBefore = new Date("2020-01-01T00:00:00Z")
      cert.validity.notAfter = new Date(kind === "expired" ? "2021-01-01T00:00:00Z" : "2040-01-01T00:00:00Z")
      cert.setSubject([{ name: "commonName", value: "Disposable preview upstream" }])
      cert.setIssuer(kind === "untrusted" ? cert.subject.attributes : ca.subject.attributes)
      cert.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: kind === "mismatched"
          ? [{ type: 2, value: "wrong.invalid" }]
          : [{ type: 7, ip: "127.0.0.1" }, { type: 2, value: "localhost" }] },
      ])
      cert.sign(kind === "untrusted" ? keys.privateKey : caKeys.privateKey, forge.md.sha256.create())
      return [kind, { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) }]
    }))
    fs.writeFileSync(path.join(directory, "certificates.json"), JSON.stringify(fixtures))

    const fixture = fileURLToPath(new URL("./fixtures/preview-security.ts", import.meta.url))
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const env = { ...process.env, PREVIEW_SECURITY_DIRECTORY: directory,
        NODE_EXTRA_CA_CERTS: path.join(directory, "ca.pem"),
        // Explicit transport verification must win even over this inherited
        // bypass. This is confined to the disposable child, not production.
        NODE_TLS_REJECT_UNAUTHORIZED: "0" }
      // Node marks test workers in the environment. The isolated TLS child is
      // a fresh runner, not a recursive node:test invocation in this worker.
      delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT
      const child = spawn(process.execPath, ["--import", "tsx", "--test", fixture], {
        env,
        signal: AbortSignal.timeout(90_000),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let output = ""
      child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk) })
      child.stderr.on("data", (chunk) => { output += chunk; process.stdout.write(chunk) })
      child.once("error", reject)
      child.once("close", (code) => resolve({ code, output }))
    })
    assert.equal(result.code, 0, result.output)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
