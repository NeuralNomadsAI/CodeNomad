import assert from "node:assert/strict"
import { sleep } from "./lib.mjs"

export async function waitIdle(daemon, id) {
  const deadline = Date.now() + 60_000
  for (;;) {
    const { data } = await daemon.call("GET", "/api/session/active")
    const active = Array.isArray(data) ? data.map(x => x.id ?? x.sessionID ?? x) : Object.keys(data ?? {})
    if (!(id ? active.includes(id) : active.length)) return
    if (Date.now() >= deadline) throw Error("Seed session did not settle")
    await sleep(40)
  }
}

export async function seed(daemon, turns, count) {
  const create = async title => (await daemon.call("POST", "/api/session", { title, location: { directory: daemon.project } })).data.id
  const foreground = await create("Seed foreground history")
  const background = []
  for (let i = 1; i < count; i++) background.push(await create(`Background ${String(i).padStart(2, "0")}`))
  const prompt = async (id, text) => {
    await daemon.call("POST", `/api/session/${id}/prompt`, { text })
    await waitIdle(daemon, id)
    const { data } = await daemon.call("GET", `/api/session/${id}`)
    assert.equal(data.outcome, "succeeded", `Seed turn failed: ${text}`)
  }
  await Promise.all(background.map(async id => {
    for (let i = 1; i <= 3; i++) await prompt(id, `SEED${i} background`)
  }))
  for (let i = 1; i <= turns; i++) {
    await prompt(foreground, `SEED${i} history turn ${i}: explain the fixture module`)
    if (i % 50 === 0) console.log(`Seeded ${i} of ${turns} history turns`)
  }
  return [foreground, ...background]
}

export async function withSampleSessions(daemon, templates, run) {
  const sessions = []
  let failure
  try {
    for (let i = 0; i < templates.length; i++) {
      const { data: { id } } = await daemon.call("POST", `/api/session/${templates[i]}/fork`, {})
      sessions.push(id)
      if (i === 0) await daemon.call("PATCH", `/api/session/${id}`, { title: "Foreground history" })
    }
    await run(sessions)
  } catch (error) {
    failure = error
  } finally {
    const cleanup = []
    for (const id of sessions) {
      try { await daemon.call("DELETE", `/api/session/${id}`) } catch (error) { cleanup.push(error) }
    }
    if (cleanup.length) throw new AggregateError(failure ? [failure, ...cleanup] : cleanup, "Could not remove benchmark sessions", { cause: failure })
  }
  if (failure) throw failure
}
