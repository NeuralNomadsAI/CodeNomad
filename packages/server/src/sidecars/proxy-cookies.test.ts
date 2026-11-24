import assert from "node:assert/strict"
import test from "node:test"
import { sidecarRequestCookies, sidecarResponseCookies } from "./proxy-cookies"

test("cookie filtering removes every reserved pair without decoding or merging service values", () => {
  assert.equal(sidecarRequestCookies(["custom=first; svc=a=b%2Fc", " custom = second ; theme=dark; codenomad_session_10_20=sibling"], "custom"), "svc=a=b%2Fc; theme=dark")
  assert.equal(sidecarRequestCookies("custom=x; codenomad_session=y; __Host-codenomad_device=z", "custom"), undefined)
  const headers = { "Set-Cookie": ["custom=x; Path=/", "svc=abc; Expires=Wed, 21 Oct 2037 07:28:00 GMT", "codenomad_session_old=y; Path=/", "__Host-codenomad_device=z; Secure; Path=/"], "set-cookie2": "custom=z", location: "/login" }
  assert.deepEqual(sidecarResponseCookies(headers, "custom"), { "Set-Cookie": [headers["Set-Cookie"][1]], location: "/login" })
  assert.equal(headers["Set-Cookie"].length, 4, "does not mutate the upstream header object")
  assert.deepEqual(sidecarResponseCookies({ "set-cookie": "custom=x; Path=/" }, "custom"), {})
  assert.deepEqual(sidecarResponseCookies({ "set-cookie": "svc=x; Path=/" }, "custom"), { "set-cookie": "svc=x; Path=/" })
  for (const cookie of ["=custom=poison; Path=/", "custom; Path=/", "bad name=x", "=codenomad_session=poison"]) {
    assert.deepEqual(sidecarResponseCookies({ "set-cookie": cookie }, "custom"), {})
  }
})
