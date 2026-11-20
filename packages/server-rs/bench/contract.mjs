// Mode `contract`: session placement header, foreign sessions, worktree outline and pending requests.
import assert from "node:assert/strict"

const post = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const PLACEMENT = { "x-codenomad-session-placement": "1" }

export async function run({ call, fixture, folder, other: otherFolder }) {
  const read = async (route, init, expected) => {
    const r = await call(route, { signal: AbortSignal.timeout(60000), ...init })
    const text = await r.text()
    if (expected !== undefined) assert.equal(r.status, expected, `${route}: ${text}`)
    return { status: r.status, body: text ? JSON.parse(text) : null }
  }
  const opened = await read("/api/workspaces", post({ path: folder }), 201)
  const w = opened.body, base = `/api/workspaces/${w.id}`, instance = `/workspaces/${w.id}/instance/api`
  const root = w.location?.directory ?? w.path
  const out = {}
  let tree
  try {
    const rootSession = await fixture.client.session.create({ location: { directory: root }, title: "Placement root" })
    const placed = await read(`${instance}/session/${rootSession.id}`, { headers: PLACEMENT }, 200)
    out.rootPlacement = { status: placed.status, id: placed.body.data.id === rootSession.id, slug: placed.body.data.listWorktreeSlug }
    const plain = await read(`${instance}/session/${rootSession.id}`, {}, 200)
    out.rootPlain = { status: plain.status, slug: (plain.body.data ?? plain.body).listWorktreeSlug ?? null }

    tree = (await read(`${base}/worktrees`, post({ slug: "contract-placement", fromSlug: "root" }), 201)).body
    const inTree = await fixture.client.session.create({ location: { directory: tree.serviceDirectory }, title: "Placement worktree" })
    const treePlaced = await read(`${instance}/session/${inTree.id}`, { headers: PLACEMENT }, 200)
    out.worktreePlacement = { status: treePlaced.status, slugMatchesInventory: treePlaced.body.data.listWorktreeSlug === tree.slug }
    const outline = await read(`${base}/session-history/outline`, post({ sessionID: inTree.id }))
    out.worktreeOutline = { status: outline.status, blocked: outline.body?.status === "blocked" ? outline.body.reason : null }

    const foreign = await fixture.client.session.create({ location: { directory: otherFolder }, title: "Placement foreign" })
    const refused = await read(`${instance}/session/${foreign.id}`, { headers: PLACEMENT })
    out.foreignPlacement = { status: refused.status, body: refused.body }
    const refusedPlain = await read(`${instance}/session/${foreign.id}/message`)
    out.foreignMessages = { status: refusedPlain.status, body: refusedPlain.body }

    const pending = await read(`${base}/pending-requests?${new URLSearchParams({ directories: root })}`)
    out.pending = { status: pending.status, supported: pending.body?.supported,
      directories: pending.body?.directories?.map(d => ({ status: d.status, locations: d.locations?.length })) }
  } finally {
    if (tree) await call(`${base}/worktrees/${tree.slug}`, { method: "DELETE" }).catch(() => {})
    await call(`/api/workspaces/${w.id}`, { method: "DELETE" }).catch(() => {})
  }
  return out
}
