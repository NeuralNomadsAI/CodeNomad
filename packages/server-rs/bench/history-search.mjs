import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { privateGit } from "./fixtures.mjs"

const post = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

export async function prepare({ root }) {
  // Ranked history deliberately refuses Git environment overrides. A private
  // enclosing checkout stops discovery before reaching the CodeNomad checkout.
  await privateGit(root, "history-search-boundary")
}

export async function run({ call, fixture, folder, root, other }) {
  const workspace = path.join(root, folder)
  const linked = path.join(root, "history-linked")
  const independent = path.join(linked, "history-independent")
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/.test(key))),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "fixture.gitconfig") }
  const git = (...args) => execFileSync("git", args, { windowsHide: true, env })
  git("-C", workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "history fixture")
  git("-C", workspace, "worktree", "add", "--quiet", "--detach", linked, "HEAD")
  git("init", "-q", independent)
  const registered = await fixture.client.location.get({ location: { directory: workspace } })
  await fixture.client.worktree.refresh({ projectID: registered.project.id })
  const opened = await call("/api/workspaces", post({ path: folder }))
  assert.equal(opened.status, 201)
  const { id, location } = await opened.json()
  const route = `/api/workspaces/${id}`
  const db = new DatabaseSync(path.join(fixture.root, "fixture.db"))
  db.exec("PRAGMA busy_timeout=5000")
  const ask = async (action, body, status = 200) => {
    const response = await call(`${route}/session-history/${action}`, post(body))
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  try {
    const nested = path.join(location.directory, "history-nested")
    await mkdir(nested)
    const session = async (directory, title) => fixture.client.session.create({ location: { directory }, title })
    const own = await session(location.directory, "Root history")
    const sub = await session(nested, "Subfolder history")
    const checkout = await session(linked, "Linked history")
    const foreign = await session(other, "Foreign history")
    const independentSession = await session(independent, "Independent nested history")
    const insert = db.prepare("INSERT INTO session_message(id,session_id,type,seq,data,time_created,time_updated) VALUES (?,?,'user',?,?,?,?)")
    const seed = (session, label, count, offset, text = `fixture apricot nebula ${label}`, sequence = 0) => {
      for (let seq = 1; seq <= count; seq++) {
        const created = Date.UTC(2026, 0, 1) + offset + seq
        insert.run(`msg_history_${label}_${seq}`, session.id, sequence + seq,
          JSON.stringify({ text: `${text} ${seq}`, time: { created } }), created, created)
      }
    }
    seed(own, "root", 36, 0)
    seed(sub, "nested", 1, 100)
    seed(checkout, "linked", 1, 150, "fixture linkedneedle")
    seed(foreign, "foreign", 1, 200)
    seed(independentSession, "independent", 1, 300)
    const query = { sessionID: own.id, query: "apricot nebula" }
    const first = await ask("query", query)
    assert.equal(first.status, "page", JSON.stringify(first))
    assert.equal(first.hits.length, 32)
    assert(typeof first.cursor === "string")
    const next = await ask("query", { ...query, cursor: first.cursor })
    const ids = [...first.hits, ...next.hits].map(hit => hit.messageID)
    assert.equal(new Set(ids).size, 36)
    assert(ids.every(id => id.startsWith("msg_history_root_")))
    await ask("query", { ...query, cursor: first.cursor, query: "changed" }, 400)
    await ask("query", { ...query, sessionID: foreign.id }, 403)
    await ask("query", { ...query, sessionID: independentSession.id }, 403)
    await ask("query", { purpose: "prune" }, 400)
    const rankedInput = { version: 1, query: "apricot nebula", limit: 2 }
    const ranked = await ask("ranked", rankedInput)
    assert.equal(ranked.status, "ranked", JSON.stringify(ranked))
    assert.equal(ranked.matchedSessions, 2, JSON.stringify(ranked))
    assert.deepEqual(new Set(ranked.hits.map(hit => hit.sessionID)), new Set([own.id, sub.id]))
    assert.equal(ranked.sessions, undefined)
    assert.equal(ranked.caps, undefined)
    const linkedRank = await ask("ranked", { ...rankedInput, query: "linkedneedle" })
    assert.deepEqual(linkedRank.hits.map(hit => hit.messageID), ["msg_history_linked_1"], JSON.stringify(linkedRank))
    await ask("ranked", { ...rankedInput, since: "2026-02-30" }, 400)
    await ask("ranked", { ...rankedInput, cursor: "unrecognized" }, 400)
    const pages = { version: 1, query: "windowmarker" }
    db.exec("BEGIN")
    seed(own, "older", 1, 500, "windowmarker older", 36)
    seed(own, "filler", 16_384, 501, "padding", 37)
    seed(own, "newer", 1, 17_000, "windowmarker newer", 16_421)
    db.exec("COMMIT")
    const latest = await ask("ranked", pages)
    assert.equal(latest.status, "ranked", JSON.stringify(latest))
    assert.equal(typeof latest.cursor, "string")
    assert(latest.capped)
    assert.deepEqual(latest.hits.map(hit => hit.messageID), ["msg_history_newer_1"])
    seed(own, "after", 1, 18_000, "windowmarker after", 16_422)
    let examined = latest.scanned, token = latest.cursor
    const older = []
    for (let index = 0; token !== null && index < 12; index++) {
      const page = await ask("ranked", { ...pages, cursor: token })
      assert.equal(page.status, "ranked", JSON.stringify(page))
      assert.equal(page.examinedBefore, examined)
      examined += page.scanned
      token = page.cursor
      older.push(...page.hits.map(hit => hit.messageID))
    }
    assert.equal(token, null)
    assert.deepEqual(older, ["msg_history_older_1"])
    return { chronological: ids, ranking: ranked.hits.map(hit => hit.messageID), scopedSessions: ranked.matchedSessions,
      rankedScanned: ranked.scanned, filteredDirectory: ranked.exclusions.includes("foreign_directory"), rankedContinuation: true }
  } finally {
    db.close()
    await call(route, { method: "DELETE" })
  }
}
