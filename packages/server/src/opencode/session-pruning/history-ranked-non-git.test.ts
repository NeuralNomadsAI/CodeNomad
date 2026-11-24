import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "./plugin"
import { storageDirectory } from "./storage-path"
import { storageKey } from "./claim-fence"
import { rankedDirectoryOwnership } from "./history-ranked-ownership"

async function git(root: string) {
  await mkdir(path.join(root, ".git", "objects"), { recursive: true })
  await mkdir(path.join(root, ".git", "refs"))
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
}

for (const folder of ["plain-project", "config/temporary-workspaces/scratch"]) {
  test(`directory-only tool and RPC own root/plain descendants and exclude repositories (${folder})`, async () => {
    const temporary = path.join(os.tmpdir(), "opencode")
    await mkdir(temporary, { recursive: true })
    const parent = await mkdtemp(path.join(temporary, "ranked-non-git-"))
    const root = path.join(parent, folder), filename = path.join(parent, "fixture.db")
    await mkdir(path.join(root, "plain", "deep"), { recursive: true })
    await git(path.join(root, "clone"))
    await git(path.join(root, "global-clone"))
    await mkdir(path.join(root, "bare"))
    await writeFile(path.join(root, "bare", "HEAD"), "ref: refs/heads/main\n")
    await mkdir(path.join(root, "broken", ".git"), { recursive: true })
    const db = new DatabaseSync(filename)
    let cleanup: (() => void | Promise<void>) | void = undefined
    try {
      db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,workspace_id TEXT,project_id TEXT,title TEXT);
        CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,data TEXT);`)
      for (const [id, subfolder, project] of [
        ["root", "", "p"], ["plain", "plain/deep", "p"], ["clone", "clone", "p"],
        ["global-clone", "global-clone", "global"], ["bare", "bare", "p"], ["broken", "broken", "p"], ["missing", "missing", "p"],
      ]) {
        db.prepare("INSERT INTO session_v2 VALUES (?,?,NULL,?,?)").run(id!, storageDirectory(path.join(root, subfolder!)), project!, `${id} title`)
        db.prepare("INSERT INTO session_message VALUES (?,?,'user',1,?)").run(id!, id!, JSON.stringify({ text: `needle ${id}` }))
      }
      let tool: any, handlers: any
      cleanup = await plugin.setup({
        app: {}, options: { databasePath: filename }, location: { directory: root, project: { id: "p" } },
        session: { get: async () => ({ location: { directory: root }, projectID: "p" }) },
        storage: {
          set: async (key: string, value: unknown) => { db.prepare("INSERT INTO kv VALUES (?,?)").run(storageKey(key), JSON.stringify(value)) },
          remove: async (key: string) => { db.prepare("DELETE FROM kv WHERE key=?").run(storageKey(key)) },
        },
        rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { dispose: async () => {} } } },
        tool: { transform: async (transform: (editor: any) => void) => { transform({ add: (value: unknown) => { tool = value } }); return { dispose: async () => {} } } },
      } as any)
      const result = await handlers.historyRanked({ version: 1, query: "needle" }, { signal: new AbortController().signal })
      assert.deepEqual(result.hits.map((hit: any) => hit.sessionID).sort(), ["plain", "root"])
      assert.equal(result.scanned, 2); assert.equal(result.matchedSessions, 2)
      assert.deepEqual(result.sessions.map((owner: any) => owner.sessionID).sort(), ["plain", "root"])
      assert.deepEqual(result.exclusions.sort(), ["foreign_directory", "unknown_directory"])
      const output = await tool.execute({ query: "needle" }, { sessionID: "root", signal: new AbortController().signal })
      assert.match(output.content, /2 session\(s\)/)
      assert.match(output.content, /"root title"/); assert.match(output.content, /"plain title"/)
      for (const id of ["clone", "bare", "broken", "missing"]) assert(!output.content.includes(`${id} title`))
    } finally { await cleanup?.(); db.close(); await rm(parent, { recursive: true, force: true }) }
  })
}

test("directory-only cache revalidates nested repositories and the root's physical identity", async () => {
  const temporary = path.join(os.tmpdir(), "opencode")
  await mkdir(temporary, { recursive: true })
  const parent = await mkdtemp(path.join(temporary, "ranked-non-git-fences-"))
  const root = path.join(parent, "root"), child = path.join(root, "child"), sibling = path.join(parent, "sibling")
  await mkdir(child, { recursive: true }); await mkdir(sibling)
  try {
    const check = await rankedDirectoryOwnership(root, new AbortController().signal)
    assert.equal(await check(root), "owned")
    assert.equal(await check(child), "owned")
    assert.equal(await check(sibling), "foreign_directory")
    await git(child)
    assert.equal(await check(child), "owned", "request-local cache retains the first observation")
    assert.equal(await check(child, true), "foreign_directory")
    const replaced = await rankedDirectoryOwnership(root, new AbortController().signal)
    await rename(root, path.join(parent, "replaced")); await mkdir(root)
    const fresh = await rankedDirectoryOwnership(root, new AbortController().signal)
    assert.equal(await fresh(root), "owned")
    assert.equal(await replaced(root, true), "unknown_directory", "a replaced root loses authority")
    const changed = await rankedDirectoryOwnership(root, new AbortController().signal)
    await git(root)
    assert.equal(await changed(root, true), "unknown_directory", "a changed discovery identity loses authority")
  } finally { await rm(parent, { recursive: true, force: true }) }
})
