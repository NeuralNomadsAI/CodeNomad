import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveAutomationBridgeUrl, resolvePluginBaseUrl } from "../listener-base-url"

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

  it("uses the exact concrete loopback bind host", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpsStart: { protocol: "https", bindHost: "127.0.0.2", port: 9898 },
        remoteUrl: "https://127.0.0.2:9898",
      }),
      "https://127.0.0.2:9898",
    )
  })

  it("uses bracketed IPv6 loopback for IPv6 wildcard listeners", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpsStart: { protocol: "https", bindHost: "0:0:0:0:0:0:0:0", port: 9898 },
        remoteUrl: "https://[2001:db8::20]:9898",
      }),
      "https://[::1]:9898",
    )
  })

  it("formats concrete IPv6 fallback listeners", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpsStart: { protocol: "https", bindHost: "2001:db8::20", port: 9898 },
      }),
      "https://[2001:db8::20]:9898",
    )
  })
})

describe("resolveAutomationBridgeUrl", () => {
  it("uses IPv4 loopback for an internal HTTP listener", () => {
    assert.equal(resolveAutomationBridgeUrl({ protocol: "http", bindHost: "0.0.0.0", port: 3210 }), "http://127.0.0.1:3210")
  })

  it("rejects HTTPS and non-loopback listeners", () => {
    assert.throws(() => resolveAutomationBridgeUrl({ protocol: "https", bindHost: "127.0.0.1", port: 3210 }), /loopback HTTP/)
    assert.throws(() => resolveAutomationBridgeUrl({ protocol: "http", bindHost: "192.168.1.2", port: 3210 }), /loopback HTTP/)
  })
})
