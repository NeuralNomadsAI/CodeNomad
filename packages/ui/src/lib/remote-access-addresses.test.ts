import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { splitRemoteAddresses } from "./remote-access-addresses"

describe("splitRemoteAddresses", () => {
  it("keeps the first remote address visible and collapses the rest", () => {
    const result = splitRemoteAddresses([
      { ip: "127.0.0.1", family: "ipv4", scope: "loopback", remoteUrl: "https://127.0.0.1:9898" },
      { ip: "192.168.1.128", family: "ipv4", scope: "external", remoteUrl: "https://192.168.1.128:9898" },
      { ip: "172.24.96.1", family: "ipv4", scope: "external", remoteUrl: "https://172.24.96.1:9898" },
    ])

    assert.equal(result.recommended?.ip, "192.168.1.128")
    assert.deepEqual(result.hidden.map((address) => address.ip), ["172.24.96.1"])
  })
})
