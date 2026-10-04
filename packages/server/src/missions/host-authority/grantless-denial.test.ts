import assert from "node:assert/strict"
import test from "node:test"
import { authorityDigest } from "../authority-protocol"
import { fixture } from "./test-fixture"
import type { NativeMirrorObservation } from "./registry"

const denials = [
  ["lifecycle", { action: "stop" }, "stopped"],
  ["delete", { deleteManagedSessions: false }, "deleted"],
  ["revoke", {}, null],
] as const

for (const [method, payload, terminal] of denials) {
  test(`fresh signed create can accept ${method} denial without adoption or a grant`, async t => {
    const f = await fixture({ freshMission: true }); t.after(f.cleanup)
    await f.prepare()
    await f.execute(await f.body("create", { objective: "Private prepared mission", template: "custom", prepared: true }))
    assert.equal((await f.host.read())!.mirror, null)
    assert.equal((await f.core.state(f.target.missionID)).grant, null)
    await f.execute(await f.body(method, payload))
    const host = (await f.host.read())!, native = await f.core.state(f.target.missionID)
    assert.equal(host.mirror, null)
    assert.equal(host.pendingDigest, null)
    assert.equal(host.epoch, 0)
    assert.equal(native.grant, null)
    assert.equal(native.terminal, terminal)
    assert.deepEqual(native.pendingRequestIDs, [])
  })
}

test("grantless denials require epoch zero, exact binding and current qualification", async t => {
  const f = await fixture({ freshMission: true }); t.after(f.cleanup)
  await f.prepare()
  await f.execute(await f.body("create", { objective: "Private prepared mission", template: "custom", prepared: true }))
  const before = (await f.host.read())!, raw = f.canonical(await f.readRaw())
  for (const override of [{ epoch: 1 }, { missionID: "msn_foreign" }, { coordinatorSessionID: "ses_foreign" }]) {
    await assert.rejects(f.host.sign(f.request, await f.body("revoke", {}, override), before.revision))
    assert.equal(f.canonical(await f.readRaw()), raw)
  }
  const denial = await f.body("revoke", {})
  f.loseNative()
  await assert.rejects(f.host.sign(f.request, denial, before.revision))
  assert.equal(f.canonical(await f.readRaw()), raw)
})

test("a null native grant cannot erase an existing protected grant on denial", async t => {
  const f = await fixture(); t.after(f.cleanup)
  await f.prepare(); await f.execute(await f.body("adopt", {}))
  const body = await f.body("revoke", {})
  const signed = await f.host.sign(f.request, body, (await f.host.read())!.revision)
  const result = await f.core.execute(signed, { apply: async () => { throw new Error("Revoke has no execution effect") } }, new AbortController().signal)
  f.setObservation({ operation: { ...result, grant: null }, revision: body.expectedRevision,
    terminal: null, pendingRequestIDs: [] })
  const pending = (await f.host.read())!
  await assert.rejects(f.host.accept(f.request, authorityDigest(body), pending.revision), /native-mirror-missing/)
  assert.equal((await f.host.read())!.mirror!.state, "revoked")
  assert.equal((await f.host.read())!.pendingDigest, pending.pendingDigest)
})

for (const [method, payload] of denials.filter(([method]) => method !== "revoke")) {
  test(`grantless ${method} cannot accept an applied receipt without its terminal tombstone`, async t => {
    const f = await fixture({ freshMission: true }); t.after(f.cleanup)
    await f.prepare()
    await f.execute(await f.body("create", { objective: "Private prepared mission", template: "custom", prepared: true }))
    const body = await f.body(method, payload)
    const signed = await f.host.sign(f.request, body, (await f.host.read())!.revision)
    const result = await f.core.execute(signed, { apply: f.apply }, new AbortController().signal)
    const observation: NativeMirrorObservation = { operation: result, revision: body.expectedRevision, terminal: null, pendingRequestIDs: [] }
    f.setObservation(observation)
    const pending = (await f.host.read())!
    await assert.rejects(f.host.accept(f.request, pending.pendingDigest!, pending.revision), /terminal-denial-missing/)
    assert.equal((await f.host.read())!.pendingDigest, pending.pendingDigest)
    assert.equal((await f.host.read())!.mirror, null)
  })
}
