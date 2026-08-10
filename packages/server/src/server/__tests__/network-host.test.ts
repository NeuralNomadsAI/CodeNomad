import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../network-host"

describe("network host helpers", () => {
  it("recognizes IPv4 and IPv6 wildcard forms", () => {
    assert.equal(isWildcardHost("0.0.0.0"), true)
    assert.equal(isWildcardHost("::"), true)
    assert.equal(isWildcardHost("0:0:0:0:0:0:0:0"), true)
    assert.equal(isWildcardHost("::1"), false)
  })

  it("recognizes concrete IPv4 and IPv6 loopback forms", () => {
    assert.equal(isLoopbackHost("localhost"), true)
    assert.equal(isLoopbackHost("127.0.0.2"), true)
    assert.equal(isLoopbackHost("::1"), true)
    assert.equal(isLoopbackHost("0:0:0:0:0:0:0:1"), true)
    assert.equal(isLoopbackHost("2001:db8::1"), false)
  })

  it("brackets IPv6 literals for URLs", () => {
    assert.equal(formatHostForUrl("192.168.1.20"), "192.168.1.20")
    assert.equal(formatHostForUrl("::1"), "[::1]")
    assert.equal(formatHostForUrl("[2001:db8::20]"), "[2001:db8::20]")
  })
})
