import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { Effect } from "effect"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { MANAGED_OWNER_RPC_ID, withNativeRecurrenceRpc } from "./managed-owner-plugin"

test("packaged Missions entry carries the owned namespace issuer and native observer", async () => {
  const script = await readFile(new URL("../../../scripts/build-missions-plugin.mjs", import.meta.url), "utf8")
  assert.match(script, /missions\/managed-owner-plugin\.ts/)
  const output = await build({ entryPoints: [fileURLToPath(new URL("./managed-owner-plugin.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", target: "node22" })
  const code = output.outputFiles[0]!.text
  assert.ok(code.includes(MANAGED_OWNER_RPC_ID))
  assert.ok(code.includes("missions.observeNativeManagedOwner"))
  assert.ok(code.includes("new NativeMissionAuthorityStore"))
  assert.ok(code.includes("register(MANAGED_OWNER_RPC"))
  assert.ok(code.includes("recurrenceSnapshot:"))
  assert.ok(code.includes("recurrenceRead:"))
  assert.ok(code.includes("recurrenceCreate:"))
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
  const observer = { observe: () => Effect.succeed("owner") }
  await Effect.runPromise(Effect.scoped(wrapped.register({ id: MANAGED_OWNER_RPC_ID } as never, observer as never)))
  assert.equal(captured, observer, "the independent owner observer is not rewritten")
})
