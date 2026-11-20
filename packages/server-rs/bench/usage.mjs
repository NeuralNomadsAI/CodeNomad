// Mode `usage`: Settings › Stats (`/api/workspaces/:id/service-usage`, `/owner`, `/cache`): the native
// aggregate, the display cache written in `state.yaml` and its restored period, query refusals and an
// unknown workspace. Digests and connection keys are replaced by their first-seen rank.
import { setTimeout as delay } from "node:timers/promises"

export async function run({ call, folder }) {
  const ranks = new Map()
  const scrub = value => {
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, scrub(v)]))
    if (typeof value === "string" && /^(?:[a-f0-9]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value)) {
      if (!ranks.has(value)) ranks.set(value, `<key ${ranks.size + 1}>`)
      return ranks.get(value)
    }
    return value
  }
  const read = async route => {
    const response = await call(route, { signal: AbortSignal.timeout(30000) })
    const text = await response.text()
    let body = text
    try { body = text ? JSON.parse(text) : null } catch {}
    return scrub({ status: response.status, body })
  }
  const opened = await call("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: folder }) })
  const { id } = await opened.json()
  for (let i = 0; i < 200 && (await (await call(`/api/workspaces/${id}`)).json()).status !== "ready"; i++) await delay(100)
  const base = `/api/workspaces/${id}/service-usage`
  const zone = encodeURIComponent("Europe/Paris")
  const day = 86_400_000, to = Date.UTC(2026, 10, 20)
  const saved = async count => {
    for (let i = 0; i < 100; i++) {
      const state = await (await call("/api/storage/state/ui")).json()
      if ((state.serviceUsage?.entries?.length ?? 0) >= count) return
      await delay(100)
    }
  }
  const out = {}
  out.owner = await read(`${base}/owner`)
  out.cacheEmpty = await read(`${base}/cache?timezone=${zone}`)
  out.week = await read(`${base}?from=${to - 7 * day}&to=${to}&timezone=${zone}`)
  await saved(1)
  out.ownerKnown = await read(`${base}/owner`)
  out.cacheWeek = await read(`${base}/cache?timezone=${zone}&days=7`)
  out.cacheSelected = await read(`${base}/cache?timezone=${zone}`)
  out.restored = await read(`${base}?from=${to - day}&to=${to}&timezone=${zone}&restorePeriod=true`)
  out.month = await read(`${base}?from=${to - 30 * day}&to=${to}&timezone=${zone}`)
  await saved(2)
  out.cacheMonth = await read(`${base}/cache?timezone=${zone}`)
  out.cacheHex = await read(`${base}/cache?timezone=${zone}&days=0x7`)
  out.restoreNegative = await read(`${base}?from=0&to=1000&timezone=${zone}&restorePeriod=true`)
  out.odd = await read(`${base}?from=${to - 1.5 * day}&to=${to}&timezone=UTC`)
  out.refused = []
  for (const query of ["", `from=1&timezone=${zone}`, `from=2&to=1&timezone=${zone}`, `from=0&to=${367 * day}&timezone=${zone}`, `from=0&to=10&timezone=Mars%2FBase`,
    `from=0&to=10&timezone=${zone}&extra=1`, `from=0&from=1&to=10&timezone=${zone}`, `from=0.5&to=10&timezone=${zone}`, `from=-1&to=10&timezone=${zone}`,
    `from=0&to=10&timezone=${zone}&restorePeriod=yes`, `from=&to=0x10&timezone=utc`, `from=0&to=1e3&timezone=%2B05%3A00`])
    out.refused.push({ query, ...(await read(`${base}?${query}`)) })
  for (const query of ["", "timezone=", `timezone=${zone}&days=8`, `timezone=${zone}&extra=1`, `timezone=${zone}&days=7&days=30`])
    out.refused.push({ query, cache: await read(`${base}/cache?${query}`) })
  const missing = "/api/workspaces/00000000-0000-4000-8000-000000000000/service-usage"
  out.missing = [await read(`${missing}/owner`), await read(`${missing}/cache?timezone=${zone}`), await read(`${missing}?from=0&to=10&timezone=${zone}`)]
  out.state = scrub((await (await call("/api/storage/state/ui")).json()).serviceUsage)
  await call(`/api/workspaces/${id}`, { method: "DELETE" })
  return out
}
