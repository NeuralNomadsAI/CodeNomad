import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { acceptsIpv4Loopback, resolveAutomationBridgeUrl, resolvePluginBaseUrl, resolvePreferredRemoteListener } from "../listener-base-url"

describe("resolvePreferredRemoteListener", () => {
  it("keeps the effective bind host paired with the preferred listener", () => {
    const httpStart = { protocol: "http" as const, bindHost: "127.0.0.1", port: 9899 }
    const httpsStart = { protocol: "https" as const, bindHost: "0.0.0.0", port: 9898 }

    assert.deepEqual(resolvePreferredRemoteListener({ httpStart, httpsStart }), httpsStart)
    assert.deepEqual(resolvePreferredRemoteListener({ httpStart, httpsStart: null }), httpStart)
  })
})

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

  it("rejects HTTPS, non-loopback and IPv6 listeners that 127.0.0.1 cannot reach", () => {
    assert.equal(resolveAutomationBridgeUrl({ protocol: "http", bindHost: "127.0.0.1", port: 3210 }), "http://127.0.0.1:3210")
    for (const listener of [
      { protocol: "https" as const, bindHost: "127.0.0.1" },
      { protocol: "http" as const, bindHost: "192.168.1.2" },
      // Registrations only name 127.0.0.1: an IPv6 binding (even dual-stack) or a
      // name that may resolve to ::1 is not proven to answer there.
      { protocol: "http" as const, bindHost: "::1" },
      { protocol: "http" as const, bindHost: "::" },
      { protocol: "http" as const, bindHost: "localhost" },
      { protocol: "http" as const, bindHost: "127.0.0.2" },
    ]) {
      assert.throws(() => resolveAutomationBridgeUrl({ ...listener, port: 3210 }), /reachable on 127\.0\.0\.1/, listener.bindHost)
      if (listener.protocol === "http") assert.equal(acceptsIpv4Loopback(listener.bindHost), false, listener.bindHost)
    }
    assert.equal(acceptsIpv4Loopback("0.0.0.0"), true)
  })
})
