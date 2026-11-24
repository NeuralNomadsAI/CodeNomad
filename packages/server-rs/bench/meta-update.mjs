import assert from "node:assert/strict"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"

const fixtures = new Map()
const repo = "/repos/NeuralNomadsAI/CodeNomad/releases"
const stableAt = "2026-01-01T00:00:00Z"
const previewAt = "2026-01-02T00:00:00Z"
const futureAt = "2026-01-03T00:00:00Z"
const manifest = [{ name: "latest.json" }]
const release = (tag, at, extra = {}) => ({ tag_name: tag, published_at: at, assets: manifest, ...extra })
const preview = release("v0.0.1-dev-fixture", previewAt, { prerelease: true, body: "Preview fixture notes" })
const stable = release("v9.1.0", futureAt, { html_url: "https://example.invalid/stable" })
const previewOffer = {
  version: "0.0.1-dev-fixture", tag: preview.tag_name, channel: "preview", publishedAt: previewAt, notes: preview.body,
  url: "https://github.com/NeuralNomadsAI/CodeNomad/releases/tag/v0.0.1-dev-fixture",
}
const stableOffer = { version: "9.1.0", tag: stable.tag_name, channel: "stable", publishedAt: futureAt, url: stable.html_url }

export async function configure(...backends) {
  for (const { root } of backends) {
    const fixture = { list: [release("v0.0.0", stableAt)], requests: [], hold: false, installed: null }
    const send = (res, data) => res.writeHead(data === null ? 404 : 200, { "content-type": "application/json" }).end(JSON.stringify(data))
    const server = createServer((req, res) => {
      fixture.requests.push(req.url)
      if (req.url === `${repo}?per_page=30`) {
        const page = fixture.list
        if (fixture.hold) {
          fixture.pending = () => send(res, page)
        } else send(res, page)
      } else if (req.url.startsWith(`${repo}/tags/`)) {
        send(res, req.url === `${repo}/tags/v${fixture.installed?.tag_name.slice(1)}` ? fixture.installed : null)
      } else send(res, null)
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    fixtures.set(root, { fixture, server, origin: `http://127.0.0.1:${server.address().port}/` })
  }
  return "  updateFeed: preview\n"
}

export const environment = root => ({ CNRS_FIXTURE_RELEASES: fixtures.get(root).origin, CODENOMAD_GITHUB_REPO: "NeuralNomadsAI/CodeNomad" })
export async function close() {
  await Promise.all([...fixtures.values()].map(({ server }) => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections()
  })))
}

async function until(check, label) {
  const end = Date.now() + 10_000
  for (;;) {
    const result = await check()
    if (result) return result
    assert(Date.now() < end, label)
    await delay(25)
  }
}

export async function run({ call, fixture: backend }) {
  const { fixture } = fixtures.get(backend.root)
  const meta = async () => {
    const response = await call("/api/meta")
    assert.equal(response.status, 200)
    return response.json()
  }
  const feed = async updateFeed => {
    const response = await call("/api/storage/config/server", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ updateFeed }) })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await meta()).updateFeed, updateFeed)
  }
  const readOffer = () => until(async () => (await meta()).update, "preview offer never appeared")
  const initial = await meta()
  assert.equal(initial.updateFeed, "preview")
  await until(async () => (await meta()).update === null, "completed Preview lookup must publish no offer")
  assert.deepEqual(fixture.requests.splice(0), [`${repo}?per_page=30`, `${repo}/tags/v${initial.serverVersion}`])
  await feed("stable")
  const steady = (await meta()).update
  assert.equal(steady, null)
  assert.equal(fixture.requests.length, 0)
  fixture.installed = release(`v${initial.serverVersion}`, stableAt)
  fixture.list = [release("v99.0.0", futureAt, { draft: true }), release("v99.0.1", futureAt, { assets: [] }),
    release("v8.0.0", stableAt), preview]
  await feed("preview")
  const first = await readOffer()
  assert.deepEqual(first, previewOffer)
  assert.deepEqual(fixture.requests, [`${repo}?per_page=30`, `${repo}/tags/v${initial.serverVersion}`])
  await feed("stable")
  assert.equal((await meta()).update, null)
  fixture.list = [stable, fixture.installed]
  await feed("preview")
  const final = await readOffer()
  assert.deepEqual(final, stableOffer)
  await feed("stable")
  fixture.hold = true
  fixture.list = [preview, fixture.installed]
  await feed("preview")
  const replyLate = await until(() => fixture.pending, "preview request not in flight")
  await feed("stable")
  assert.equal((await meta()).update, null)
  fixture.hold = false
  fixture.list = [stable, fixture.installed]
  await feed("preview")
  assert.deepEqual(await readOffer(), stableOffer)
  replyLate()
  // Observe several HTTP reads after releasing the earlier Preview response.
  for (let i = 0; i < 10; i++) {
    await delay(25)
    assert.deepEqual((await meta()).update, stableOffer)
  }
  await feed("stable")
  const afterLate = await meta()
  assert.equal(afterLate.update, null)
  assert.equal(afterLate.updateFeed, "stable")
  return { first, final, steady, afterLate: afterLate.update }
}
