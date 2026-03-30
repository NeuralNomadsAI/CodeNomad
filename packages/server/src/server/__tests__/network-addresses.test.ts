import assert from "node:assert/strict"
import os from "node:os"
import { describe, it } from "node:test"

import { isAdvertisableRemoteAddress, resolveNetworkAddresses } from "../network-addresses"

describe("resolveNetworkAddresses", () => {
  it("keeps RFC1918 addresses grouped without preferring one private range over another", () => {
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

  it("marks link-local addresses as non-advertisable for terminal output", () => {
    assert.equal(isAdvertisableRemoteAddress({ ip: "169.254.10.20", scope: "external" }), false)
    assert.equal(isAdvertisableRemoteAddress({ ip: "192.168.1.128", scope: "external" }), true)
    assert.equal(isAdvertisableRemoteAddress({ ip: "127.0.0.1", scope: "loopback" }), false)
  })

  it("keeps a usable LAN address advertisable when a link-local address is discovered first", () => {
    const addresses = [
      { address: "169.254.10.20", family: "IPv4", internal: false },
      { address: "192.168.1.128", family: "IPv4", internal: false },
    ]

    usingMockedNetworkInterfaces(addresses, () => {
      const result = resolveNetworkAddresses({ host: "0.0.0.0", protocol: "https", port: 9898 })
      const primaryAdvertisable = result.find((entry) => isAdvertisableRemoteAddress(entry))

      assert.equal(primaryAdvertisable?.ip, "192.168.1.128")
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
