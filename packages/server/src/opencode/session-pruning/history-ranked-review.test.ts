import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setImmediate as tick } from "node:timers/promises"
import plugin from "./plugin"
import { storageDirectory } from "./storage-path"
import { storageKey } from "./claim-fence"
import { searchTerms } from "./history-ranking"
import { queryRankedHistory } from "./history-ranked-store"
import { historyRankedInputSchema } from "./history-ranked-contract"

const signal = () => new AbortController().signal
async function git(directory: string) {
  await mkdir(path.join(directory, ".git", "objects"), { recursive: true })
  await mkdir(path.join(directory, ".git", "refs"))
  await writeFile(path.join(directory, ".git", "HEAD"), "ref: refs/heads/main\n")
}
function database(filename = ":memory:") {
  const db = new DatabaseSync(filename)
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,title TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,data TEXT);`)
  return db
}
function seed(db: DatabaseSync, id: string, directory: string, project = "p", text = "needle") {
  db.prepare("INSERT INTO session_v2 VALUES (?,?,NULL,?,?)").run(id, storageDirectory(directory), project, `${id} title`)
  db.prepare("INSERT INTO session_message VALUES (?,?,'user',1,?)").run(id, id, JSON.stringify({ text }))
}

test("review P1: tool and RPC exclude nested clones and unknown directories before ranking/counting", async () => {
  const temporary = path.join(os.tmpdir(), "opencode")
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(path.join(temporary, "ranked-ownership-"))
  const db = database(path.join(root, "fixture.db"))
  let cleanup: (() => void | Promise<void>) | void = undefined
  try {
    await git(root)
    await git(path.join(root, "independent-clone"))
    await git(path.join(root, "another-clone"))
    const linked = path.join(root, "linked"), admin = path.join(root, ".git", "worktrees", "linked")
    await mkdir(linked); await mkdir(admin, { recursive: true })
    await writeFile(path.join(linked, ".git"), `gitdir: ${admin}\n`)
    await writeFile(path.join(admin, "commondir"), "../..\n")
    await writeFile(path.join(admin, "gitdir"), path.join(linked, ".git"))
    await writeFile(path.join(admin, "HEAD"), "ref: refs/heads/linked\n")
    await mkdir(path.join(root, "plain"))
    await mkdir(path.join(root, "unreadable"))
    await mkdir(path.join(root, "unreadable", ".git")) // malformed administrative entry: fail closed
    for (const [id, directory, project] of [
      ["root", root, "p"], ["plain", path.join(root, "plain"), "p"], ["linked", linked, "p"],
      ["secret-same-project", path.join(root, "independent-clone"), "p"], ["secret-global", path.join(root, "another-clone"), "global"],
      ["missing", path.join(root, "missing"), "p"], ["unreadable", path.join(root, "unreadable"), "p"],
    ]) seed(db, id!, directory!, project!)
    let tool: any, handlers: any
    const ctx = {
      app: {}, options: { databasePath: path.join(root, "fixture.db") }, location: { directory: root, project: { id: "p" } },
      session: { get: async () => ({ location: { directory: root }, projectID: "p" }) },
      storage: { set: async (key: string, value: unknown) => { db.prepare("INSERT INTO kv VALUES (?,?)").run(storageKey(key), JSON.stringify(value)) },
        remove: async (key: string) => { db.prepare("DELETE FROM kv WHERE key=?").run(storageKey(key)) } },
      rpc: { register: async (_: unknown, implementation: unknown) => { handlers = implementation; return { dispose: async () => {} } } },
      tool: { transform: async (transform: (editor: any) => void) => { transform({ add: (value: unknown) => { tool = value } }); return { dispose: async () => {} } } },
    }
    cleanup = await plugin.setup(ctx as any)
    const result = await handlers.historyRanked({ version: 1, query: "needle" }, { signal: signal() })
    assert.deepEqual(result.hits.map((hit: any) => hit.sessionID).sort(), ["linked", "plain", "root"])
    assert.equal(result.scanned, 3); assert.equal(result.candidates, 3); assert.equal(result.matchedSessions, 3)
    assert.deepEqual(result.exclusions.sort(), ["foreign_directory", "unknown_directory"])
    assert(!JSON.stringify(result).includes("secret"))
    const output = await tool.execute({ query: "needle" }, { sessionID: "root", signal: signal() })
    assert(!output.content.includes("secret")); assert.match(output.content, /3 session\(s\)/)
    assert.match(output.content, /unknown_directory/)
    await rm(path.join(root, ".git", "HEAD"))
    const unknown = await handlers.historyRanked({ version: 1, query: "needle" }, { signal: signal() })
    assert.equal(unknown.hits.length, 0); assert.equal(unknown.scanned, 0)
    assert(unknown.exclusions.includes("unknown_directory"))
  } finally { await cleanup?.(); db.close(); await rm(root, { recursive: true, force: true }) }
})

for (const [name, query] of [
  ["one long term", "a".repeat(199) + "b"],
  ["six long terms", "bcdefg".split("").map(suffix => "a".repeat(30) + suffix).join(" ")],
]) test(`review P2: first yield stays responsive on a near-limit adversarial row (${name})`, async () => {
  const db = database()
  try {
    seed(db, "large", "/repo", "p", "a".repeat(16_777_000))
    const started = performance.now()
    const firstYield = tick().then(() => performance.now() - started)
    await queryRankedHistory(db, { directory: "/repo", projectID: "p" }, historyRankedInputSchema.parse({ version: 1, query }), signal(), async () => "owned")
    const elapsed = await firstYield
    console.log(`${name}: first yield ${elapsed.toFixed(0)} ms`)
    assert(elapsed < 1500, `first yield took ${elapsed.toFixed(0)} ms`)
  } finally { db.close() }
})

test("review P3: token deduplication preserves dotted-capital-I /iu self-equivalence", () => {
  assert.deepEqual(searchTerms("İstanbul İSTANBUL istanbul"), ["İstanbul", "istanbul"])
})

test("review P3: dotted-capital-I queries find their exact stored text", async () => {
  const db = database()
  try {
    seed(db, "dotted", "/repo", "p", "İstanbul")
    for (const query of ["İstanbul", "İSTANBUL"]) {
      const result = await queryRankedHistory(db, { directory: "/repo", projectID: "p" }, historyRankedInputSchema.parse({ version: 1, query }), signal(), async () => "owned")
      assert.deepEqual(result.hits.map(hit => hit.messageID), ["dotted"], query)
    }
  } finally { db.close() }
})
