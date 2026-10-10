import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { Effect } from "effect"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { HUMAN_ANSWER_RPC } from "../../missions/human-answer"
import { withNativeRecurrenceRpc } from "./managed-owner-plugin"

test("packaged Missions entry ships one-time, recurring and human-answer RPC without the retired authority layer", async () => {
  const script = await readFile(new URL("../../../scripts/build-missions-plugin.mjs", import.meta.url), "utf8")
  assert.match(script, /missions\/managed-owner-plugin\.ts/)
  const output = await build({ entryPoints: [fileURLToPath(new URL("./managed-owner-plugin.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", target: "node22", metafile: true })
  const code = output.outputFiles[0]!.text
  assert.ok(code.includes(HUMAN_ANSWER_RPC.id))
  assert.ok(code.includes("recurrenceSnapshot:"))
  assert.ok(code.includes("recurrenceRead:"))
  assert.ok(code.includes("recurrenceCreate:"))
  // No literal for the retired namespace can be reached from the shipped lifecycle.
  assert.equal(code.includes("codenomad-missions/authority-"), false)
  assert.equal(code.includes("NativeMissionAuthorityStore"), false)
  assert.equal(code.includes("codenomad.missions.managed-owner"), false)
  const inputs = Object.keys(output.metafile.inputs)
  for (const retired of ["missions/authority-store.ts", "missions/host-authority/", "opencode/missions/native-managed-owner.ts"])
    assert.equal(inputs.some(input => input.includes(retired)), false, retired)
})

test("one Missions registration retains native snapshot, exact read, paused CREATE and existing handlers", async () => {
  let captured: Record<string, unknown> | undefined
  const rpc = Object.assign(() => ({}), { register: (_definition: unknown, handlers: Record<string, unknown>) =>
    Effect.sync(() => { captured = handlers }) })
  const wrapped = withNativeRecurrenceRpc({ rpc } as never)
  const snapshot = () => Effect.succeed("existing snapshot")
  await Effect.runPromise(Effect.scoped(wrapped.register(CODENOMAD_MISSIONS_RPC, { snapshot } as never)))
  assert.equal(captured?.snapshot, snapshot)
  for (const name of ["recurrenceSnapshot", "recurrenceRead", "recurrenceCreate"]) {
    assert.equal(typeof captured?.[name], "function", name)
  }
  const other = { observe: () => Effect.succeed("other") }
  await Effect.runPromise(Effect.scoped(wrapped.register({ id: "codenomad.other" } as never, other as never)))
  assert.equal(captured, other, "other registrations are not rewritten")
})
