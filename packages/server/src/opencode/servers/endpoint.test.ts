import assert from "node:assert/strict"
import { test } from "node:test"
import { admitAddress, normalizeExplicitOrigin, resolveExplicitAddress } from "./endpoint"
import { assertLoopbackServiceUrl } from "../../workspaces/service-state"

test("root origin normalization rejects URL hazards before normalization", () => {
  assert.equal(normalizeExplicitOrigin("HTTPS://Example.COM:443/"), "https://example.com")
  for (const value of ["ftp://localhost", "https://a/b", "https://a/..", "https://a/%2e", "https://a?", "https://a#", "https://a?x", "https://a#x", "https://u:p@a", "https://@a", "https://a\\b", " https://a", "https://*"]) {
    assert.throws(() => normalizeExplicitOrigin(value), value)
  }
})

test("IP classification covers private, loopback, mapped and forbidden ranges", () => {
  for (const address of ["127.0.0.1", "127.2.3.4", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(admitAddress(address).loopback, true, address)
  }
  for (const address of ["10.0.0.1", "172.16.2.1", "192.168.1.1", "fd12::1", "fc00::1", "2606:4700::1111", "::ffff:192.168.1.1"]) {
    assert.equal(admitAddress(address).loopback, false, address)
    assert.doesNotThrow(() => normalizeExplicitOrigin(`https://${address.includes(":") ? `[${address}]` : address}`))
    assert.throws(() => normalizeExplicitOrigin(`http://${address.includes(":") ? `[${address}]` : address}`))
  }
  for (const address of ["0.0.0.0", "0.1.2.3", "224.0.0.1", "255.255.255.255", "169.254.169.254", "100.100.100.200", "168.63.129.16", "::", "ff02::1", "fe80::1", "fec0::1", "fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "2002:7f00:1::", "64:ff9b::a9fe:a9fe"]) {
    assert.throws(() => admitAddress(address), address)
  }
  assert.throws(() => normalizeExplicitOrigin("http://remote.example"))
  assert.equal(normalizeExplicitOrigin("http://localhost:123/"), "http://localhost:123")
  assert.throws(() => normalizeExplicitOrigin("http://0"))
  assert.throws(() => normalizeExplicitOrigin("https://2852039166"))
})

test("DNS validates all answers and rechecks every dispatch", async () => {
  let calls = 0
  const resolve = async () => [{ address: ++calls === 1 ? "192.168.1.1" : "169.254.169.254", family: 4 }]
  assert.equal((await resolveExplicitAddress("https://test.example", resolve)).address, "192.168.1.1")
  await assert.rejects(resolveExplicitAddress("https://test.example", resolve), { code: "forbidden_address" })
  await assert.rejects(resolveExplicitAddress("https://test.example", async () => [{ address: "127.0.0.1", family: 4 }, { address: "fe80::1", family: 6 }]))
  await assert.rejects(resolveExplicitAddress("http://localhost", async () => [{ address: "10.0.0.1", family: 4 }]), { code: "https_required" })
  await assert.rejects(resolveExplicitAddress("https://test.example", async () => []), { code: "dns" })
})

test("shared service loopback guard remains independent", () => {
  assert.equal(assertLoopbackServiceUrl("http://0.0.0.0:12").hostname, "127.0.0.1")
  for (const value of ["http://localhost", "http://127.0.0.1", "http://[::1]"]) assert.doesNotThrow(() => assertLoopbackServiceUrl(value))
  for (const value of ["https://example.com", "https://10.0.0.1", "https://192.168.0.1"]) assert.throws(() => assertLoopbackServiceUrl(value))
})
