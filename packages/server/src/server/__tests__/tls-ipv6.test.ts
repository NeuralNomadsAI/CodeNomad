import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"

import type { Logger } from "../../logger"
import { resolveHttpsOptions } from "../tls"

it("generates a certificate with a concrete IPv6 address SAN", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-tls-ipv6-"))
  const logger = { info() {}, warn() {}, error() {}, child() { return logger } } as unknown as Logger

  try {
    const resolved = resolveHttpsOptions({ enabled: true, configDir, host: "2001:db8::20", logger })
    assert.ok(resolved)
    const certificate = new crypto.X509Certificate(resolved.httpsOptions.cert)
    assert.match(certificate.subjectAltName ?? "", /IP Address:2001:DB8:0:0:0:0:0:20/i)
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})
