import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolvePluginBaseUrl } from "../listener-base-url"

describe("resolvePluginBaseUrl", () => {
  it("keeps loopback URLs for default local listeners", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpsStart: { protocol: "https", bindHost: "127.0.0.1", port: 9898 },
        remoteUrl: "https://localhost:9898",
      }),
      "https://127.0.0.1:9898",
    )
  })

  it("uses the concrete LAN listener when no loopback listener exists", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpsStart: { protocol: "https", bindHost: "192.168.1.25", port: 9898 },
        remoteUrl: "https://192.168.1.25:9898",
      }),
      "https://192.168.1.25:9898",
    )
  })

  it("prefers loopback for wildcard listeners because 0.0.0.0 accepts loopback", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpsStart: { protocol: "https", bindHost: "0.0.0.0", port: 9898 },
        remoteUrl: "https://192.168.1.25:9898",
      }),
      "https://127.0.0.1:9898",
    )
  })

  it("keeps loopback HTTP when remote HTTPS also exists", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpStart: { protocol: "http", bindHost: "127.0.0.1", port: 9899 },
        httpsStart: { protocol: "https", bindHost: "192.168.1.25", port: 9898 },
        remoteUrl: "https://192.168.1.25:9898",
      }),
      "http://127.0.0.1:9899",
    )
  })
})
