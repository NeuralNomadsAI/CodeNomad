import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import test from "node:test"
import Fastify from "fastify"
import type { Logger } from "../logger"
import { resolveHttpsOptions } from "../server/tls"
import { registerRemoteServerRoutes } from "../server/routes/remote-servers"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"

test("a private-CA leaf without its issuer offers target-scoped explicit TLS consent", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "probe-private-ca-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const logger = { info() {}, warn() {}, error() {} } as unknown as Logger
  const tls = resolveHttpsOptions({ enabled: true, configDir: directory, host: "localhost", logger })!
  const cert = tls.httpsOptions.cert.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)![0]
  const remote = await startFakeCodeNomad({ tls: { key: tls.httpsOptions.key, cert }, anonymous: true })
  t.after(() => remote.close())
  const app = Fastify()
  registerRemoteServerRoutes(app, { logger })
  t.after(() => app.close())
  const probe = async (skipTlsVerify = false) => (await app.inject({
    method: "POST", url: "/api/remote-servers/probe", payload: { baseUrl: remote.origin, skipTlsVerify },
  })).json()
  const refused = await probe()
  assert.equal(refused.ok, false)
  assert.equal(refused.errorCode, "tls_error")
  assert.equal(remote.state.requests.length, 0)
  const consented = await probe(true)
  assert.equal(consented.ok, true)
  assert.equal(consented.normalizedUrl, remote.origin)
  assert.equal(consented.skipTlsVerify, true)
  const requests = remote.state.requests.length
  assert.equal((await probe()).errorCode, "tls_error")
  assert.equal(remote.state.requests.length, requests)
})

test("a trusted certificate with a wrong hostname stays outside the TLS-consent error path", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "probe-wrong-name-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const logger = { info() {}, warn() {}, error() {} } as unknown as Logger
  const tls = resolveHttpsOptions({ enabled: true, configDir: directory, host: "localhost", logger })!
  const forge = createRequire(import.meta.url)("node-forge") as typeof import("node-forge")
  const cert = forge.pki.certificateFromPem(tls.httpsOptions.cert.toString())
  cert.setExtensions([...cert.extensions.filter(extension => extension.name !== "subjectAltName"),
    { name: "subjectAltName", altNames: [{ type: 2, value: "other.test" }] }])
  cert.sign(forge.pki.privateKeyFromPem(fs.readFileSync(path.join(directory, "tls/ca-key.pem"), "utf8")), forge.md.sha256.create())
  const previous = getCACertificates()
  setDefaultCACertificates([...previous, fs.readFileSync(tls.caCertPath!, "utf8")])
  t.after(() => setDefaultCACertificates(previous))
  const remote = await startFakeCodeNomad({ tls: { key: tls.httpsOptions.key, cert: forge.pki.certificateToPem(cert) }, anonymous: true })
  t.after(() => remote.close())
  const app = Fastify()
  registerRemoteServerRoutes(app, { logger })
  t.after(() => app.close())
  const response = await app.inject({ method: "POST", url: "/api/remote-servers/probe", payload: { baseUrl: remote.origin } })
  assert.equal(response.json().ok, false)
  assert.equal(response.json().errorCode, "err_tls_cert_altname_invalid")
  assert.equal(remote.state.requests.length, 0)
})
