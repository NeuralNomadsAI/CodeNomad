import assert from "node:assert/strict"
import { test } from "node:test"
import { webTabTitle } from "./web-tab-title"

const at = (href: string) => new URL(href)

test("names the serving host, with a non-default port", () => {
  assert.equal(webTabTitle(at("https://node-a.example/")), "node-a.example — CodeNomad")
  assert.equal(webTabTitle(at("https://node-a.example:443/")), "node-a.example — CodeNomad")
  assert.equal(webTabTitle(at("http://192.168.1.20:9898/")), "192.168.1.20:9898 — CodeNomad")
  assert.equal(webTabTitle(at("https://[fd00::2]:8443/")), "[fd00::2]:8443 — CodeNomad")
})

test("keeps the product name on loopback", () => {
  for (const href of ["http://localhost:9898/", "http://app.localhost/", "http://localhost.:9898/",
    "http://app.localhost./", "http://LOCALHOST/", "http://127.0.0.1:9898/",
    "http://127.1.2.3/", "http://[::1]:9898/", "http://[::ffff:127.0.0.1]/"]) {
    assert.equal(webTabTitle(at(href)), "CodeNomad", href)
  }
})
