import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { classifyCodeNomadLink, codeNomadLinkName } from "./codenomad-link.ts"

describe("pasted CodeNomad links", () => {
  it("recognizes a Remote Control pairing link and keeps its code out of the saved address", () => {
    assert.deepEqual(classifyCodeNomadLink("  https://abc.opentunnel.xyz/remote-pair#code-123  "), {
      kind: "pairing",
      baseUrl: "https://abc.opentunnel.xyz",
      entryUrl: "https://abc.opentunnel.xyz/remote-pair#code-123",
    })
  })

  it("reduces a direct-access address to its origin", () => {
    assert.deepEqual(classifyCodeNomadLink("http://192.168.1.20:9898/some/page?x=1"), { kind: "address", baseUrl: "http://192.168.1.20:9898" })
    assert.deepEqual(classifyCodeNomadLink("https://box.example"), { kind: "address", baseUrl: "https://box.example" })
  })

  it("refuses text, other schemes and links carrying credentials", () => {
    assert.equal(classifyCodeNomadLink("my server"), null)
    assert.equal(classifyCodeNomadLink("ftp://box.example"), null)
    assert.equal(classifyCodeNomadLink("http://user:secret@box.example:4096"), null)
    assert.equal(classifyCodeNomadLink("http://user@box.example"), null)
    // An http pairing page is not a Remote Control link: it is probed as an address.
    assert.deepEqual(classifyCodeNomadLink("http://box.example/remote-pair#x"), { kind: "address", baseUrl: "http://box.example" })
  })

  it("names a new server after its host", () => {
    assert.equal(codeNomadLinkName("https://abc.opentunnel.xyz"), "abc.opentunnel.xyz")
    assert.equal(codeNomadLinkName("http://127.0.0.1:9898"), "127.0.0.1:9898")
  })
})
