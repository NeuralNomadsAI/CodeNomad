import assert from "node:assert/strict"
import { test } from "node:test"
import fixtures from "./urls.json"
import { canonicalEndpoint } from "../src/endpoint.ts"

test("canonical HTTPS roots agree with native fixtures", () => {
  for (const [input, expected] of fixtures.valid) assert.equal(canonicalEndpoint(input), expected, input)
})
test("reject deceptive URLs and launcher-origin collisions before normalization", () => {
  for (const input of fixtures.invalid) assert.throws(() => canonicalEndpoint(input), Error, input)
})
