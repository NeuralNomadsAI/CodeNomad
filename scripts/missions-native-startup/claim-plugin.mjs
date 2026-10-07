// Fixture-only: one consent-bound custom tool, no passage dispatch or scheduler.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import emit from "./emit.cjs"

emit.module("claim-plugin-module", import.meta.url)

export async function readClaimEnrollment(input, context, directory) {
  const root = process.env.NATIVE_STARTUP_ROOT, nonce = process.env.NATIVE_STARTUP_NONCE
  const bytes = await readFile(path.join(root, "claim-enrollment.json"), "utf8")
  assert.ok(bytes.length < 4096)
  const enrolled = JSON.parse(bytes)
  assert.equal(input.nonce, nonce)
  assert.equal(enrolled.nonce, nonce)
  assert.equal(enrolled.sessionID, context.sessionID)
  assert.equal(enrolled.directory, directory)
  assert.equal(enrolled.permission.effect, "allow") // fixture receipt, not production authority
  return enrolled
}

export default {
  id: "missions.native-claim-fixture",
  async setup(ctx) {
    const root = process.env.NATIVE_STARTUP_ROOT
    const nonce = process.env.NATIVE_STARTUP_NONCE
    const directory = ctx.location.directory
    assert.ok(["project", "idle-project"].some(name => path.resolve(root, name) === path.resolve(directory)))
    emit("claim-plugin-setup", directory)
    await ctx.session.hook("http.request", event => {
      event.request.headers.set("x-claim-kind", event.kind)
      event.request.headers.set("x-claim-session", event.sessionID)
    })
    await ctx.tool.transform(editor => editor.add({
      name: "fixture_hold",
      description: "Wait inside one fixture-owned native tool until interrupted; never dispatch work.",
      input: { type: "object", properties: { nonce: { type: "string", const: nonce } }, required: ["nonce"], additionalProperties: false },
      options: { codemode: false, permission: "fixture_hold" },
      async execute(input, context) {
        await readClaimEnrollment(input, context, directory)
        emit("claim-tool-enter", directory, context)
        try {
          // Bounded proof hold only; native cancellation aborts it during the immediate restart.
          await delay(60_000, undefined, { signal: context.signal })
          emit("claim-tool-timeout", directory, context)
          return { content: "Fixture hold expired" }
        } finally {
          if (context.signal.aborted) emit("claim-tool-aborted", directory, context)
        }
      },
    }))
  },
}
