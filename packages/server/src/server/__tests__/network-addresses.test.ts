import assert from "node:assert/strict"
import os from "node:os"
import { describe, it } from "node:test"

import { resolveNetworkAddresses, resolveRemoteAddresses } from "../network-addresses"

describe("resolveNetworkAddresses", () => {
  it("preserves interface order among external addresses", () => {
    const addresses = [
      { address: "172.24.0.1", family: "IPv4", internal: false },
      { address: "192.168.1.128", family: "IPv4", internal: false },
      { address: "10.0.0.8", family: 4, internal: false },
      { address: "127.0.0.1", family: "IPv4", internal: true },
      { address: "169.254.10.20", family: "IPv4", internal: false },
    ]

    usingMockedNetworkInterfaces(addresses, () => {
      const result = resolveNetworkAddresses({ host: "0.0.0.0", protocol: "https", port: 9898 })

      assert.deepEqual(
        result.map((entry) => entry.ip),
        ["172.24.0.1", "192.168.1.128", "10.0.0.8", "169.254.10.20", "127.0.0.1"],
      )
    })
  })

  it("advertises only a concrete IPv4 bind host", () => {
    const result = resolveNetworkAddresses({ host: "127.0.0.2", protocol: "https", port: 9898 })

    assert.deepEqual(result, [
      { ip: "127.0.0.2", family: "ipv4", scope: "loopback", remoteUrl: "https://127.0.0.2:9898" },
    ])
  })

  it("formats concrete IPv6 bind hosts as valid URLs", () => {
    const result = resolveNetworkAddresses({ host: "::1", protocol: "https", port: 9898 })

    assert.deepEqual(result, [
      { ip: "::1", family: "ipv6", scope: "loopback", remoteUrl: "https://[::1]:9898" },
    ])
  })

  it("enumerates matching IPv6 interfaces for compact and expanded wildcards", () => {
    const addresses = [
      { address: "2001:db8::20", family: "IPv6", internal: false },
      { address: "::1", family: 6, internal: true },
      { address: "192.168.1.20", family: "IPv4", internal: false },
    ]

    usingMockedNetworkInterfaces(addresses, () => {
      for (const host of ["::", "0:0:0:0:0:0:0:0"]) {
        const result = resolveNetworkAddresses({ host, protocol: "https", port: 9898 })
        assert.deepEqual(result, [
          { ip: "2001:db8::20", family: "ipv6", scope: "external", remoteUrl: "https://[2001:db8::20]:9898" },
          { ip: "::1", family: "ipv6", scope: "loopback", remoteUrl: "https://[::1]:9898" },
        ])
      }
    })
  })
})

describe("resolveRemoteAddresses", () => {
  it("keeps all external addresses user-visible while preferring non-link-local addresses for the primary URL", () => {
    const addresses = [
      { address: "169.254.10.20", family: "IPv4", internal: false },
      { address: "192.168.1.128", family: "IPv4", internal: false },
      { address: "172.24.0.1", family: "IPv4", internal: false },
    ]

    usingMockedNetworkInterfaces(addresses, () => {
      const result = resolveRemoteAddresses({ host: "0.0.0.0", protocol: "https", port: 9898 })

      assert.deepEqual(
        result.userVisible.map((entry) => entry.ip),
        ["192.168.1.128", "172.24.0.1", "169.254.10.20"],
      )
      assert.equal(result.primaryRemoteUrl, "https://192.168.1.128:9898")
    })
  })

  it("prefers private LAN addresses over public addresses", () => {
    const addresses = [
      { address: "203.0.113.40", family: "IPv4", internal: false },
      { address: "192.168.1.128", family: "IPv4", internal: false },
      { address: "8.8.8.8", family: "IPv4", internal: false },
    ]

    usingMockedNetworkInterfaces(addresses, () => {
      const result = resolveRemoteAddresses({ host: "0.0.0.0", protocol: "https", port: 9898 })

      assert.deepEqual(
        result.userVisible.map((entry) => entry.ip),
        ["192.168.1.128", "203.0.113.40", "8.8.8.8"],
      )
      assert.equal(result.primaryRemoteUrl, "https://192.168.1.128:9898")
    })
  })

  it("uses a public address when no private LAN address is available", () => {
    const addresses = [
      { address: "169.254.10.20", family: "IPv4", internal: false },
      { address: "203.0.113.40", family: "IPv4", internal: false },
    ]

    usingMockedNetworkInterfaces(addresses, () => {
      const result = resolveRemoteAddresses({ host: "0.0.0.0", protocol: "https", port: 9898 })

      assert.deepEqual(result.userVisible.map((entry) => entry.ip), ["203.0.113.40", "169.254.10.20"])
      assert.equal(result.primaryRemoteUrl, "https://203.0.113.40:9898")
    })
  })
})

function usingMockedNetworkInterfaces(
  addresses: Array<{ address: string; family: string | number; internal: boolean }>,
  callback: () => void,
) {
  const original = os.networkInterfaces
  os.networkInterfaces = (() => ({
    ethernet0: addresses as unknown as ReturnType<typeof os.networkInterfaces>[string],
  })) as typeof os.networkInterfaces

  try {
    callback()
  } finally {
    os.networkInterfaces = original
  }
}
