import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import https from "node:https"
import { once } from "node:events"
import { createRequire } from "node:module"
import { describe, it } from "node:test"
import type { TestContext } from "node:test"
import type { Logger } from "../../logger"
import { resolveHttpsOptions } from "../tls"

const forge = createRequire(import.meta.url)("node-forge") as typeof import("node-forge")
const logger = { info() {}, warn() {}, error() {}, child() { return logger } } as unknown as Logger

function fixture(t: TestContext) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-tls-serial-"))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))
  const file = (name: string) => path.join(configDir, "tls", `${name}.pem`)
  const read = (name: string) => fs.readFileSync(file(name), "utf8")
  const resolve = (overrides = {}) => {
    const result = resolveHttpsOptions({ enabled: true, configDir, host: "localhost", logger, ...overrides })
    assert.ok(result)
    return result
  }
  return { configDir, file, read, resolve }
}

function checkSerial(pem: string) {
  const cert = new crypto.X509Certificate(pem)
  assert.match(cert.serialNumber, /^[0-9A-F]+$/i)
  assert(BigInt(`0x${cert.serialNumber}`) > 0n)
  const asn1 = forge.pki.certificateToAsn1(forge.pki.certificateFromPem(pem))
  const tbs = asn1.value as import("node-forge").asn1.Asn1[]
  const fields = tbs[0].value as import("node-forge").asn1.Asn1[]
  const integer = fields.find(field => field.type === forge.asn1.Type.INTEGER)!
  const bytes = Buffer.from(integer.value as string, "binary")
  assert(bytes.length <= 20, "RFC 5280 serial size limit")
  assert.equal(bytes[0] & 0x80, 0, "DER integer is positive")
  if (bytes.length > 1 && bytes[0] === 0) assert(bytes[1] & 0x80, "no redundant DER sign octet")
  return cert
}

// Re-sign a private synthetic fixture with the exact historical signed encoding.
function reissue(f: ReturnType<typeof fixture>, target: "ca" | "server", serial: string) {
  const cert = forge.pki.certificateFromPem(f.read(`${target}-cert`))
  cert.serialNumber = serial
  cert.sign(forge.pki.privateKeyFromPem(f.read("ca-key")), forge.md.sha256.create())
  fs.writeFileSync(f.file(`${target}-cert`), forge.pki.certificateToPem(cert))
}

describe("generated TLS serial numbers", () => {
  for (const hex of ["80000000000000000000000000000001", "ffffffffffffffffffffffffffffffff",
    "00008000000000000000000000000001", "00000100000000000000000000000001", "00000000000000000000000000000000"]) {
    it(`encodes both CA and leaf positively and canonically for ${hex}`, t => {
      const f = fixture(t)
      const randomBytes = crypto.randomBytes
      let draws = 0
      // RSA key generation retains its real randomness; only serial draws are forced.
      t.mock.method(crypto, "randomBytes", (size: number, ...args: unknown[]) => {
        if (size === 16 && args.length === 0) { draws++; return Buffer.from(hex, "hex") }
        return Reflect.apply(randomBytes, crypto, [size, ...args])
      })
      f.resolve()
      assert.equal(draws, 2)
      checkSerial(f.read("ca-cert"))
      checkSerial(f.read("server-cert"))
    })
  }

  for (const serial of ["80000000000000000000000000000001", "00"]) {
    it(`repairs a leaf with serial ${serial} without changing a valid CA`, async t => {
      const f = fixture(t)
      f.resolve()
      const ca = f.read("ca-cert"), key = f.read("ca-key")
      reissue(f, "server", serial)
      const oldLeaf = f.read("server-cert")
      const resolved = f.resolve()
      assert.equal(f.read("ca-cert"), ca)
      assert.equal(f.read("ca-key"), key)
      assert.notEqual(f.read("server-cert"), oldLeaf)
      const leaf = checkSerial(f.read("server-cert"))
      assert(leaf.verify(new crypto.X509Certificate(ca).publicKey))
      assert.equal(leaf.checkHost("localhost"), "localhost")
      assert.equal(leaf.checkIP("127.0.0.1"), "127.0.0.1")
      const server = https.createServer(resolved.httpsOptions, (_req, res) => res.end("verified"))
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      try {
        const port = (server.address() as import("node:net").AddressInfo).port
        const body = await new Promise<string>((resolve, reject) => {
          const req = https.get({ hostname: "127.0.0.1", port, servername: "localhost", ca, rejectUnauthorized: true }, res => {
            let body = ""
            res.setEncoding("utf8"); res.on("data", chunk => { body += chunk }); res.on("end", () => resolve(body))
            res.on("error", reject)
          })
          req.on("error", reject)
        })
        assert.equal(body, "verified")
      } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
      const current = f.read("server-cert")
      f.resolve()
      assert.equal(f.read("server-cert"), current, "repair is stable across startup")
    })
  }

  for (const serial of ["80000000000000000000000000000001", "00"]) {
    it(`replaces an invalid CA with serial ${serial} and reissues its unexpired leaf`, t => {
      const f = fixture(t)
      f.resolve()
      reissue(f, "ca", serial)
      const ca = f.read("ca-cert"), leaf = f.read("server-cert")
      const warnings: string[] = []
      f.resolve({ logger: { ...logger, warn(_data: unknown, message: string) { warnings.push(message) } } })
      assert.notEqual(f.read("ca-cert"), ca)
      assert.notEqual(f.read("server-cert"), leaf)
      const newCa = checkSerial(f.read("ca-cert"))
      assert(checkSerial(f.read("server-cert")).verify(newCa.publicKey))
      assert(warnings.some(message => message.includes("trust the replacement CA")))
      const newLeaf = f.read("server-cert"), newCaPem = f.read("ca-cert")
      f.resolve()
      assert.equal(f.read("server-cert"), newLeaf)
      assert.equal(f.read("ca-cert"), newCaPem)
    })
  }

  it("reuses valid generated credentials byte-for-byte", t => {
    const f = fixture(t)
    f.resolve()
    const before = ["ca-key", "ca-cert", "server-key", "server-cert"].map(f.read)
    f.resolve()
    assert.deepEqual(["ca-key", "ca-cert", "server-key", "server-cert"].map(f.read), before)
  })

  for (const reason of ["expired-ca", "missing-ca-key"]) {
    it(`reissues the leaf when replacing the CA for ${reason}`, t => {
      const f = fixture(t)
      f.resolve()
      const oldLeaf = f.read("server-cert")
      if (reason === "missing-ca-key") {
        fs.unlinkSync(f.file("ca-key"))
      } else {
        const ca = forge.pki.certificateFromPem(f.read("ca-cert"))
        ca.validity.notBefore = new Date(Date.now() - 172800000)
        ca.validity.notAfter = new Date(Date.now() - 86400000)
        ca.sign(forge.pki.privateKeyFromPem(f.read("ca-key")), forge.md.sha256.create())
        fs.writeFileSync(f.file("ca-cert"), forge.pki.certificateToPem(ca))
      }
      f.resolve()
      assert.notEqual(f.read("server-cert"), oldLeaf)
      assert(checkSerial(f.read("server-cert")).verify(checkSerial(f.read("ca-cert")).publicKey))
    })
  }

  it("does not modify explicitly supplied certificates or generate credentials when disabled", t => {
    const f = fixture(t)
    f.resolve()
    reissue(f, "server", "80000000000000000000000000000001")
    const before = ["ca-key", "ca-cert", "server-key", "server-cert"].map(f.read)
    const result = f.resolve({ tlsKeyPath: f.file("server-key"), tlsCertPath: f.file("server-cert"), tlsCaPath: f.file("ca-cert") })
    assert.equal(result.mode, "provided")
    assert.equal(result.httpsOptions.cert, before[3])
    assert.deepEqual(["ca-key", "ca-cert", "server-key", "server-cert"].map(f.read), before)
    const disabledDir = path.join(f.configDir, "disabled")
    assert.equal(resolveHttpsOptions({ enabled: false, configDir: disabledDir, host: "localhost", logger }), null)
    assert.equal(fs.existsSync(disabledDir), false)
  })
})
