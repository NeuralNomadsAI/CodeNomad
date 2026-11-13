import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import test from "node:test"
import type { Logger } from "../logger"
import { resolveHttpsOptions } from "../server/tls"
import { createExplicitTransport } from "../opencode/servers/transport"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"

test("SSH dial preserves remote DNS and IP certificate identity instead of trusting the loopback endpoint", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-tls-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const logger = { info() {}, warn() {}, error() {} } as unknown as Logger
  const tls = resolveHttpsOptions({ enabled: true, configDir: dir, host: "localhost", tlsSANs: "remote.test,192.0.2.10", logger })!
  const remote = await startFakeCodeNomad({ tls: tls.httpsOptions, anonymous: true })
  t.after(() => remote.close())
  const previous = getCACertificates()
  setDefaultCACertificates([...previous, fs.readFileSync(tls.caCertPath!, "utf8")])
  t.after(() => setDefaultCACertificates(previous))
  const dial = async () => ({ address: "127.0.0.1", family: 4 as const, port: Number(new URL(remote.origin).port) })
  for (const host of ["remote.test", "192.0.2.10"]) {
    const origin = `https://${host}:9898`
    const transport = createExplicitTransport({ origin, dial })
    const response = await transport.fetch(`${origin}/api/auth/status`)
    assert.deepEqual(await response.json(), { authenticated: true })
    assert.equal(remote.state.requests.at(-1)!.headers.host, `${host}:9898`)
  }
  for (const host of ["wrong.test", "192.0.2.11"]) {
    const origin = `https://${host}:9898`
    await assert.rejects(createExplicitTransport({ origin, dial }).fetch(`${origin}/api/auth/status`), { code: "tls" })
  }
})
