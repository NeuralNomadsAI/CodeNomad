import assert from "node:assert/strict"
import { isIP } from "node:net"
import { test } from "node:test"
import { normalizeExplicitOrigin, resolveExplicitAddress } from "../opencode/servers/endpoint"
import { CodeNomadServerClient } from "./client"
import { startFakeCodeNomad } from "./test-support/fake-codenomad"

const addresses = [
  "127.0.0.1", "10.0.0.1", "172.17.0.2", "192.168.1.2",
  "100.64.0.1", "100.127.255.254", "169.254.10.20", "168.63.129.16",
  "0.1.2.3", "224.0.0.1", "240.0.0.1",
  "::1", "fd7a:115c:a1e0::1", "fc00::1", "fe80::1234", "fec0::1",
  "fd00:ec2::254", "2002:a00:1::1", "2001::1", "ff02::1", "::",
  "::ffff:100.64.0.1", "::ffff:169.254.1.2",
]

test("saved profile literals and MagicDNS answers accept every IP range", async () => {
  for (const address of addresses) {
    const literal = `http://${isIP(address) === 6 ? `[${address}]` : address}:8080`
    assert.equal(normalizeExplicitOrigin(literal), new URL(literal).origin, address)
    const resolved = await resolveExplicitAddress(literal)
    assert.equal(resolved.address, new URL(literal).hostname.replace(/^\[|\]$/g, ""), address)
    const dns = await resolveExplicitAddress("http://vm.example.ts.net:8080", async hostname => {
      assert.equal(hostname, "vm.example.ts.net")
      return [{ address, family: isIP(address) }]
    })
    assert.equal(dns.address, address)
    assert.equal(dns.family, isIP(address))
  }
  const scoped = await resolveExplicitAddress("http://link-local.example:8080", async () => [{ address: "fe80::1%12", family: 6 }])
  assert.equal(scoped.address, "fe80::1%12", "the resolver's link-local interface scope is preserved")
  await assert.rejects(resolveExplicitAddress("http://vm.example.ts.net", async () => [{ address: "not-an-ip", family: 4 }]), { code: "dns" })
})

test("a MagicDNS saved origin authenticates and lists the real fake server through its pinned resolver", async t => {
  const remote = await startFakeCodeNomad()
  t.after(() => remote.close())
  const origin = `http://vm.example.ts.net:${new URL(remote.origin).port}`
  let lookups = 0
  const client = new CodeNomadServerClient(origin, { kind: "password", username: "codenomad", password: "remote-password" }, {
    resolve: async hostname => {
      assert.equal(hostname, "vm.example.ts.net")
      lookups++
      return [{ address: "127.0.0.1", family: 4 }]
    },
  })
  t.after(() => client.close())
  const response = await client.json<{ entries: unknown[] }>("/api/filesystem")
  assert.equal(response.status, 200)
  assert.ok(response.body!.entries.length > 0)
  assert.equal(remote.state.logins, 1)
  assert.equal(lookups, remote.state.requests.length)
  for (const request of remote.state.requests) {
    assert.equal(request.headers.host, new URL(origin).host)
    assert.equal(request.headers.origin, undefined)
  }
})
