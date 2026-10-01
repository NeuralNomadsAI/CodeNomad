import assert from "node:assert/strict"
import test from "node:test"
import type { ProviderUsageResponse } from "../../../../server/src/api-types"
import { createProviderUsageState, providerUsageKey, type ProviderUsageSource } from "./provider-usage-state"

const source: ProviderUsageSource = { instanceId: "instance", sessionId: "session", directory: "/repo", providerId: "openai", modelId: "gpt-5" }
const response = (used: number): ProviderUsageResponse => ({ requestedProviderId: "openai", providerId: "codex", providerName: "Codex",
  supported: true, configured: true, ok: true, fetchedAt: Date.now(), windows: { "5h": { usedPercent: used, remainingPercent: 100 - used, resetAt: null, windowSeconds: 18000 } } })

test("usage snapshot identity includes instance, session, native directory, provider and model", () => {
  for (const key of Object.keys(source) as Array<keyof ProviderUsageSource>) {
    assert.notEqual(providerUsageKey(source), providerUsageKey({ ...source, [key]: "other" }))
  }
})

test("late quota responses cannot publish into another session or overwrite a newer refresh", async () => {
  const requests: Array<{ source: ProviderUsageSource; resolve: (value: ProviderUsageResponse) => void }> = []
  let displayed: ProviderUsageResponse | null | undefined
  const state = createProviderUsageState(scope => new Promise(resolve => { requests.push({ source: scope, resolve }) }), value => { displayed = value })
  state.select(source)
  const first = state.refresh()
  state.select({ ...source, sessionId: "second" })
  const second = state.refresh()
  requests[1].resolve(response(20)); await second
  requests[0].resolve(response(10)); await first
  assert.equal(displayed?.windows["5h"].usedPercent, 20)
  assert.equal(requests[1].source.sessionId, "second")
  const old = state.refresh()
  const fresh = state.refresh()
  assert.equal(old, fresh, "concurrent reads share the complete refresh cycle")
  assert.equal(requests.length, 3)
  requests[2].resolve(response(30)); await Promise.resolve()
  assert.equal(requests.length, 4, "one trailing read reconciles demand during the first read")
  requests[3].resolve(response(40)); await fresh
  assert.equal(displayed?.windows["5h"].usedPercent, 40)
})

test("passive bursts preserve the snapshot and obsolete follow-up demand cannot cross an account boundary", async () => {
  const requests: Array<(value: ProviderUsageResponse) => void> = []
  let displayed: ProviderUsageResponse | null | undefined
  const snapshot = () => displayed
  const state = createProviderUsageState(() => new Promise(resolve => requests.push(resolve)), value => { displayed = value })
  state.select(source)
  const initial = state.refresh()
  requests[0](response(10)); await initial
  const pending = state.refresh()
  for (let i = 0; i < 20; i++) assert.equal(state.refresh(), pending)
  assert.equal(requests.length, 2)
  assert.equal(displayed?.windows["5h"].usedPercent, 10)
  state.invalidate()
  const account = state.refresh()
  requests[1](response(90)); await pending
  assert.equal(requests.length, 3, "old account's trailing demand is discarded")
  assert.equal(displayed, undefined)
  requests[2](response(40)); await account
  assert.equal(snapshot()?.windows["5h"].usedPercent, 40)
})

test("account/reconnect invalidation and inactive transitions fence pending work and clear old snapshots", async () => {
  let resolve!: (value: ProviderUsageResponse) => void
  let displayed: ProviderUsageResponse | null | undefined
  const state = createProviderUsageState(() => new Promise(done => { resolve = done }), value => { displayed = value })
  state.select(source)
  const first = state.refresh()
  resolve(response(10)); await first
  const pending = state.refresh()
  state.invalidate()
  assert.equal(displayed, undefined)
  resolve(response(20)); await pending
  assert.equal(displayed, undefined)
  const inactive = state.refresh()
  state.select(null)
  resolve(response(30)); await inactive
  assert.equal(displayed, undefined)
  state.select(source)
  assert.equal(displayed, undefined) // no warm previous account snapshot on remount
  const disposed = state.refresh()
  state.dispose()
  resolve(response(40)); await disposed
  assert.equal(displayed, undefined)
})

test("failed quota refresh does not retain a possibly different account's old result", async () => {
  let fail = false
  let displayed: ProviderUsageResponse | null | undefined
  const state = createProviderUsageState(async () => { if (fail) throw new Error("unavailable"); return response(10) }, value => { displayed = value })
  state.select(source)
  await state.refresh()
  fail = true
  await state.refresh()
  assert.equal(displayed, null)
})
