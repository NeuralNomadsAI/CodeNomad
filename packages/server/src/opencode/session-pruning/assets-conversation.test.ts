import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { CONVERSATION_SCAN, imagesConversation, lookupImagesConversation } from "./assets-conversation"
import { storageDirectory } from "./storage-path"

const directory = process.platform === "win32" ? "C:\\repo" : "/repo"
const scope = { directory, projectID: "p" }
const marked = JSON.stringify({ "codenomad.companion": "images" })
function database() {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,project_id TEXT,workspace_id TEXT,parent_id TEXT,directory TEXT,metadata TEXT,
    time_created INTEGER,time_archived INTEGER)`)
  let clock = 1000
  const add = (id: string, fields: { metadata?: string | null; parent?: string; archived?: number; dir?: string; workspace?: string; project?: string } = {}) =>
    db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?)").run(id, fields.project ?? "p", fields.workspace ?? null, fields.parent ?? null,
      storageDirectory(fields.dir ?? directory), fields.metadata === undefined ? marked : fields.metadata, clock++, fields.archived ?? null)
  const created: unknown[] = []
  const create = async (input: any) => {
    created.push(input); await delay(10)
    const id = `ses_created_${created.length}`; add(id, { metadata: JSON.stringify(input.metadata) }); return { id }
  }
  return { db, add, create, created }
}
const signal = () => new AbortController().signal

test("lookup: newest unarchived marked root of this location, never a marked child, beyond any native page", () => {
  const { db, add } = database()
  assert.deepEqual(lookupImagesConversation(db, scope), { status: "absent" })
  add("ses_old"); add("ses_images")
  for (let n = 0; n < 500; n++) add(`ses_plain_${n}`, { metadata: n % 2 ? null : "not json" })
  add("ses_child", { parent: "ses_images" }); add("ses_archived", { archived: 1 })
  add("ses_worktree", { dir: directory + "-worktree" }); add("ses_workspace", { workspace: "w" }); add("ses_project", { project: "q" })
  assert.deepEqual(lookupImagesConversation(db, scope), { status: "found", sessionID: "ses_images", created: false })
  assert.deepEqual(lookupImagesConversation(db, { ...scope, directory: directory + "-worktree" }), { status: "found", sessionID: "ses_worktree", created: false })
  assert.deepEqual(lookupImagesConversation(db, { ...scope, workspaceID: "w" }), { status: "found", sessionID: "ses_workspace", created: false })
  db.exec("DELETE FROM session_v2 WHERE id='ses_images'")
  assert.deepEqual(lookupImagesConversation(db, scope), { status: "found", sessionID: "ses_old", created: false })
  assert.equal(db.isTransaction, false)
})

test("lookup past the root scan limit is unknown, and open then creates nothing", async () => {
  const { db, add, create, created } = database()
  add("ses_images")
  db.exec("BEGIN")
  for (let n = 0; n < CONVERSATION_SCAN; n++) add(`ses_plain_${n}`, { metadata: null })
  db.exec("COMMIT")
  assert.deepEqual(lookupImagesConversation(db, scope), { status: "unknown" })
  assert.deepEqual(await imagesConversation(db, scope, { mode: "open" }, create, signal()), { status: "unknown" })
  assert.equal(created.length, 0)
  db.exec("DELETE FROM session_v2 WHERE id='ses_plain_0'")
  assert.deepEqual(lookupImagesConversation(db, scope), { status: "found", sessionID: "ses_images", created: false })
})

test("concurrent opens create one conversation; new always creates and becomes the one open finds", async () => {
  const { db, create, created } = database()
  const opened = await Promise.all([1, 2, 3].map(() => imagesConversation(db, scope, { mode: "open", title: "Images", agent: "design",
    model: { providerID: "fake", id: "chat" } }, create, signal())))
  assert.equal(created.length, 1)
  assert.deepEqual(created[0], { title: "Images", agent: "design", model: { providerID: "fake", id: "chat" }, metadata: { "codenomad.companion": "images" } })
  assert.deepEqual(opened.map(result => result.status === "found" && [result.sessionID, result.created]),
    [["ses_created_1", true], ["ses_created_1", false], ["ses_created_1", false]])
  const fresh = await imagesConversation(db, scope, { mode: "new" }, create, signal())
  assert.deepEqual(fresh, { status: "found", sessionID: "ses_created_2", created: true })
  assert.deepEqual(created[1], { metadata: { "codenomad.companion": "images" } })
  assert.deepEqual(await imagesConversation(db, scope, { mode: "open" }, create, signal()), { status: "found", sessionID: "ses_created_2", created: false })
  assert.deepEqual(await imagesConversation(db, scope, { mode: "lookup" }, create, signal()), { status: "found", sessionID: "ses_created_2", created: false })
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(imagesConversation(db, scope, { mode: "new" }, create, cancelled.signal))
  assert.equal(created.length, 2)
})
