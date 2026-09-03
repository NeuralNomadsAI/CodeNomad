import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveAutomationBridgeUrl, resolvePluginBaseUrl } from "../listener-base-url"

describe("resolvePluginBaseUrl", () => {
  it("keeps loopback URLs for default local listeners", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpsStart: { protocol: "https", bindHost: "127.0.0.1", port: 9898 },
      }),
      "https://127.0.0.1:9898",
    )
  })

  it("uses the concrete HTTPS listener when no HTTP listener exists", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpsStart: { protocol: "https", bindHost: "192.168.1.25", port: 9898 },
      }),
      "https://192.168.1.25:9898",
    )
  })

  it("resolves wildcard listeners to their loopback URL", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpsStart: { protocol: "https", bindHost: "0.0.0.0", port: 9898 },
      }),
      "https://127.0.0.1:9898",
    )
  })

  it("keeps loopback HTTP when remote HTTPS also exists", () => {
    assert.equal(
      resolvePluginBaseUrl({
        httpStart: { protocol: "http", bindHost: "127.0.0.1", port: 9899 },
        httpsStart: { protocol: "https", bindHost: "192.168.1.25", port: 9898 },
      }),
      "http://127.0.0.1:9899",
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
