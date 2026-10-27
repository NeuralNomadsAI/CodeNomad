import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "./plugin"
import { storageDirectory } from "./storage-path"
import { storageKey } from "./claim-fence"
import { historyRankedResultSchema } from "./history-ranked-contract"

test("plugin registers Code Mode search and versioned RPC, binds fresh read-only storage and disposes both", async () => {
  const temporary = path.join(os.tmpdir(), "opencode")
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(path.join(temporary, "ranked-tool-"))
  const filename = path.join(root, "fixture.db")
  const db = new DatabaseSync(filename)
  let cleanup: (() => void | Promise<void>) | void = undefined
  try {
    await mkdir(path.join(root, ".git", "objects"), { recursive: true })
    await mkdir(path.join(root, ".git", "refs"))
    await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
    db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,title TEXT);
      CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,data TEXT);`)
    db.prepare("INSERT INTO session_v2 VALUES ('s',?,NULL,'p',?)").run(storageDirectory(root), "Past\nconversation")
    db.prepare("INSERT INTO session_message VALUES ('m','s','user',?,?)").run(Date.parse("2026-01-02Z"), JSON.stringify({ text: "ÉTÉ GitHub decision" }))
    let tool: any, handlers: any, definition: any
    let toolDisposed = false, rpcDisposed = false, challenges = 0, reads = 0
    const location = { directory: root, project: { id: "p" } }
    let caller = { location: { directory: root }, projectID: "p" }
    let changeAfterRead = false
    const ctx = {
      location, options: { databasePath: filename }, app: {},
      session: { get: async () => {
        reads++
        if (changeAfterRead && reads % 2 === 0) caller = { ...caller, projectID: "foreign" }
        return caller
      } },
      storage: {
        set: async (key: string, value: unknown) => { challenges++; db.prepare("INSERT INTO kv VALUES (?,?)").run(storageKey(key), JSON.stringify(value)) },
        remove: async (key: string) => { db.prepare("DELETE FROM kv WHERE key=?").run(storageKey(key)) },
      },
      rpc: { register: async (contract: unknown, implementation: unknown) => {
        definition = contract; handlers = implementation
        return { dispose: async () => { rpcDisposed = true }, events: { emit: async () => {} } }
      } },
      tool: { transform: async (transform: (editor: any) => void) => {
        transform({ add: (value: unknown) => { tool = value } })
        return { dispose: async () => { toolDisposed = true } }
      } },
    }
    cleanup = await plugin.setup(ctx as any)
    assert.equal(challenges, 0, "registration performs no database IO")
    assert.equal(definition.id, "codenomad.session-pruning")
    assert.equal(tool.name, "session_search")
    assert.deepEqual(tool.options, { namespace: "codenomad", codemode: true })
    assert.equal(tool.input.additionalProperties, false)
    assert.equal(tool.input.properties.project, undefined)
    const signal = new AbortController().signal
    const result = await tool.execute({ query: "été GITHUB", limit: 1 }, { sessionID: "s", signal })
    assert.match(result.content, /1 session\(s\) contain a verified match/)
    assert.match(result.content, /2026-01-02 .* s "Past conversation" \[user\] ÉTÉ GitHub decision/)
    const ranked = historyRankedResultSchema.parse(await handlers.historyRanked({ version: 1, query: "github" }, { signal }))
    assert.equal(ranked.status, "ranked")
    if (ranked.status === "ranked") assert.equal(ranked.sessions[0].directory, storageDirectory(root))
    assert.equal(challenges, 2, "each search performs its own storage challenge")
    assert.equal(db.prepare("SELECT count(*) AS n FROM kv").get()!.n, 0)
    assert.equal(db.prepare("SELECT count(*) AS n FROM session_message").get()!.n, 1)
    caller = { ...caller, projectID: "foreign" }
    await assert.rejects(tool.execute({ query: "github" }, { sessionID: "s", signal }), /caller location changed/)
    assert.equal(challenges, 2)
    caller = { ...caller, projectID: "p" }; reads = 0; changeAfterRead = true
    await assert.rejects(tool.execute({ query: "github" }, { sessionID: "s", signal }), /caller location changed/)
    assert.equal(challenges, 3, "post-IO caller check fences a move during search")
    changeAfterRead = false; caller = { location: { directory: `${root}-other` }, projectID: "p" }
    await assert.rejects(tool.execute({ query: "github" }, { sessionID: "s", signal }), /caller location changed/)
    await assert.rejects(tool.execute({ query: "github", project: "foreign" }, { sessionID: "s", signal }))
    await assert.rejects(handlers.historyRanked({ version: 2, query: "github" }, { signal }))
    const abort = new AbortController(); abort.abort()
    await assert.rejects(tool.execute({ query: "github" }, { sessionID: "s", signal: abort.signal }), /abort/i)
    await cleanup?.(); cleanup = undefined
    assert(toolDisposed && rpcDisposed)
  } finally { await cleanup?.(); db.close(); await rm(root, { recursive: true, force: true }) }
})

test("failed tool registration disposes the already registered RPC", async () => {
  let disposed = false
  await assert.rejects(async () => plugin.setup({
    rpc: { register: async () => ({ dispose: async () => { disposed = true } }) },
    tool: { transform: async () => { throw new Error("registration failed") } },
  } as any), /registration failed/)
  assert(disposed)
})
