import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import type { Logger } from "../../logger"
import { resolveHttpsOptions } from "../tls"

const logger = { info() {}, warn() {}, error() {}, child() { return logger } } as unknown as Logger

describe("generated IPv6 certificates", () => {
  it("includes a concrete IPv6 address SAN", () => withTempConfig((configDir) => {
    const resolved = resolveHttpsOptions({ enabled: true, configDir, host: "2001:db8::20", logger })
    assert.ok(resolved)
    const certificate = new crypto.X509Certificate(resolved.httpsOptions.cert)
    assert.match(certificate.subjectAltName ?? "", /IP Address:2001:DB8:0:0:0:0:0:20/i)
  }))

  it("includes IPv6 loopback for a fresh wildcard certificate", () => withTempConfig((configDir) => {
    const resolved = resolveHttpsOptions({ enabled: true, configDir, host: "::", logger })
    assert.ok(resolved)
    const certificate = new crypto.X509Certificate(resolved.httpsOptions.cert)
    assert.equal(certificate.checkIP("::1"), "::1")
  }))

  it("rotates a reused certificate when required host and configured SANs change", () => withTempConfig((configDir) => {
    const initial = resolveHttpsOptions({ enabled: true, configDir, host: "127.0.0.1", logger })
    assert.ok(initial)
    const initialCertificate = new crypto.X509Certificate(initial.httpsOptions.cert)

    const rotated = resolveHttpsOptions({ enabled: true, configDir, host: "::", tlsSANs: "diagnostics.local", logger })
    assert.ok(rotated)
    const rotatedCertificate = new crypto.X509Certificate(rotated.httpsOptions.cert)

    assert.notEqual(rotatedCertificate.fingerprint256, initialCertificate.fingerprint256)
    assert.equal(rotatedCertificate.checkIP("::1"), "::1")
    assert.equal(rotatedCertificate.checkHost("diagnostics.local"), "diagnostics.local")
  }))

  it("reuses certificates for normalized IDN and scoped IPv6 SAN values", () => withTempConfig((configDir) => {
    const first = resolveHttpsOptions({ enabled: true, configDir, host: "münchen.local", tlsSANs: "fe80::1%12", logger })
    assert.ok(first)
    const firstCertificate = new crypto.X509Certificate(first.httpsOptions.cert)

    const reused = resolveHttpsOptions({ enabled: true, configDir, host: "münchen.local", tlsSANs: "fe80::1%12", logger })
    assert.ok(reused)
    const reusedCertificate = new crypto.X509Certificate(reused.httpsOptions.cert)

    assert.equal(reusedCertificate.fingerprint256, firstCertificate.fingerprint256)
    assert.equal(reusedCertificate.checkHost("xn--mnchen-3ya.local"), "xn--mnchen-3ya.local")
    assert.equal(reusedCertificate.checkIP("fe80::1"), "fe80::1")
  }))
})

function withTempConfig(callback: (configDir: string) => void) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-tls-ipv6-"))
  try {
    callback(configDir)
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }
}
