import assert from "node:assert/strict"
import test from "node:test"
import { clearCommands, fetchCommands, getCommands } from "./commands.ts"

test("command hydration cannot commit after runtime replacement", async () => {
  let resolve!: (value: unknown) => void
  const response = new Promise((done) => { resolve = done })
  let current = true
  const hydration = fetchCommands("instance", { command: { list: () => response } } as any, () => current)
  current = false
  resolve({ data: [{ name: "stale" }] })
  await hydration
  assert.deepEqual(getCommands("instance"), [])
  clearCommands("instance")
})
