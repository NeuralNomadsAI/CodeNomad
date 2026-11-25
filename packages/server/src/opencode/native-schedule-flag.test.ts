import assert from "node:assert/strict"
import test from "node:test"
import { nativeScheduleFlagOrigin, readNativeScheduleFlag } from "./native-schedule-flag"

const connection = (rpc: Record<string, () => Promise<unknown>>) => ({ assertCurrent: () => {}, client: { rpc: () => rpc } }) as any
const location = { directory: "/repo" }

test("scheduleSetting details are required unless the bundle lacks the method", async () => {
  const detailed = { enabled: true, provenance: "automations-setting", path: "/p.json", hiddenOff: ["/g.json"] }
  assert.deepEqual(await readNativeScheduleFlag(connection({ scheduleSetting: async () => detailed, scheduleFlag: async () => assert.fail() }), location), detailed)
  const original = connection({ scheduleSetting: async () => { throw { type: "rpc.method_not_found" } },
    scheduleFlag: async () => ({ enabled: true, provenance: "channel-default" }) })
  assert.deepEqual(await readNativeScheduleFlag(original, location), { enabled: true, provenance: "channel-default", hiddenOff: [] })
  for (const failure of [{ type: "rpc.unavailable" }, new Error("timed out"), { type: "rpc.internal" }])
    await assert.rejects(readNativeScheduleFlag(connection({ scheduleSetting: async () => { throw failure },
      scheduleFlag: async () => ({ enabled: true, provenance: "channel-default" }) }), location), "no silent loss of hidden OFF evidence")
})

test("pathless deciding sources have no openable origin", () => {
  for (const path of ["OPENCODE_CONFIG_CONTENT", "well-known"])
    assert.equal(nativeScheduleFlagOrigin({ enabled: false, provenance: "automations-setting", path, hiddenOff: [] }), null)
  assert.equal(nativeScheduleFlagOrigin({ enabled: false, provenance: "experimental-block", path: "/g.json", hiddenOff: [] }), "/g.json")
  assert.equal(nativeScheduleFlagOrigin({ enabled: true, provenance: "channel-default", hiddenOff: [] }), null)
})
