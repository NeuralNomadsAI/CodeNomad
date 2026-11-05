import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { classifyCodeNomadLink, codeNomadLinkName, serverDisplayName } from "./codenomad-link.ts"

describe("saved server names", () => {
  it("show the saved name, else the host name, never a raw address", () => {
    assert.equal(serverDisplayName({ name: "Box", baseUrl: "https://box.example" }), "Box")
    // A pasted address is saved under its host: it reads as the host name.
    assert.equal(serverDisplayName({ name: "127.0.0.1:9911", baseUrl: "http://127.0.0.1:9911" }), "127.0.0.1")
    assert.equal(serverDisplayName({ name: "http://127.0.0.1:9911", baseUrl: "http://127.0.0.1:9911" }), "127.0.0.1")
    assert.equal(serverDisplayName({ name: "https://desk.opentunnel.xyz/", baseUrl: "https://desk.opentunnel.xyz" }), "desk.opentunnel.xyz")
    assert.equal(serverDisplayName({ name: "  ", baseUrl: "https://box.example:8443" }), "box.example")
  })

  it("keep the port only to tell apart servers on the same host", () => {
    const first = { id: "a", name: "127.0.0.1:9911", baseUrl: "http://127.0.0.1:9911" }
    const second = { id: "b", name: "127.0.0.1:9912", baseUrl: "http://127.0.0.1:9912" }
    const named = { id: "c", name: "Lab", baseUrl: "http://127.0.0.1:9913" }
    assert.equal(serverDisplayName(first, [first, second, named]), "127.0.0.1:9911")
    assert.equal(serverDisplayName(first, [first, named]), "127.0.0.1:9911", "a named server on the same host still shares it")
    assert.equal(serverDisplayName(first, [first]), "127.0.0.1")
    assert.equal(serverDisplayName(named, [first, second, named]), "Lab")
  })
})

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
