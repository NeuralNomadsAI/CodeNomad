import assert from "node:assert/strict"
import { test } from "node:test"
import { seed } from "./seed.mjs"

test("a seed execution that became idle after failure cannot qualify an empty history", async () => {
  const daemon = {
    async call(method, route) {
      if (route === "/api/session") return { data: { id: "foreground" } }
      if (route === "/api/session/active") return { data: {} }
      if (method === "POST") return { data: { type: "user" } }
      return { data: { outcome: "failed" } }
    },
  }
  await assert.rejects(() => seed(daemon, 1, 1), /Seed turn failed/)
})
