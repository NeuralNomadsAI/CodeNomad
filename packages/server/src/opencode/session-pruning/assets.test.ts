import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { listSessionAssets, readSessionAsset } from "./assets-store"

test("asset pages/read stay session-owned, bounded, metadata-only and digest-bound through pagination, undo and deletion", async () => {
  const db = new DatabaseSync(":memory:"), signal = new AbortController().signal
  const scope = { sessionID: "s", directory: "/repo", projectID: "p" }
  db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
    INSERT INTO session_v2 VALUES ('s','/repo','p',NULL,NULL);`)
  const insert = db.prepare("INSERT INTO session_message VALUES (?,'s','assistant',?,?)")
  const uri = "data:image/png;base64,aGVsbG8="
  for (let n=0;n<70;n++) insert.run(`msg-${String(n).padStart(3,"0")}`, n, JSON.stringify({ secret:"not for the addon", content:[
    { type:"text", text:"private" }, { type:"tool", name:"mcp.paint", state:{content:[{type:"file",name:`Image ${n}`,mime:"image/png",uri}]}}] }))
  try {
    let cursor: string | undefined, names: string[] = [], firstTarget
    do {
      const page = await listSessionAssets(db, scope, cursor, signal)
      assert.equal(page.status,"page");if(page.status!=="page")return
      assert(page.entries.length<=64); assert(!JSON.stringify(page).includes("aGVsbG8"));assert(!JSON.stringify(page).includes("private"))
      firstTarget ??= page.entries[0].target
      names.push(...page.entries.map(value=>value.name));cursor=page.cursor??undefined
    } while(cursor)
    assert.equal(names.length,70);assert.equal(new Set(names).size,70);assert.equal(names[0],"Image 69")
    assert.deepEqual(await readSessionAsset(db,scope,firstTarget!,signal),{status:"asset",mime:"image/png",uri})
    assert.equal((await readSessionAsset(db,scope,{...firstTarget!,digest:"a".repeat(64)},signal)).status,"blocked")
    await assert.rejects(listSessionAssets(db,{...scope,directory:"/foreign"},undefined,signal))
    db.prepare("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify({content:[{type:"tool",state:{content:[{type:"file",mime:"text/html",uri:"file:///secret"}]}}]}),firstTarget!.messageID)
    assert.equal((await readSessionAsset(db,scope,firstTarget!,signal)).status,"blocked")
    db.prepare("UPDATE session_v2 SET revert=?").run(JSON.stringify({messageID:"msg-010"}))
    const reverted=await listSessionAssets(db,scope,undefined,signal)
    if(reverted.status!=="page")assert.fail();assert.equal(reverted.entries.length,10)
    assert.equal((await readSessionAsset(db,scope,firstTarget!,signal)).status,"blocked")
    db.prepare("DELETE FROM session_message WHERE id='msg-009'").run()
    assert.equal((await readSessionAsset(db,scope,reverted.entries[0].target,signal)).status,"blocked")
    assert.equal(db.isTransaction,false)
  } finally {db.close()}
})

test("a single message with many attachments continues without duplicates; foreign cursors and oversize messages fail closed", async () => {
  const db = new DatabaseSync(":memory:"), signal=new AbortController().signal
  const scope={sessionID:"s",directory:"/repo",projectID:"p"}
  db.exec(`CREATE TABLE session_v2(id TEXT,directory TEXT,project_id TEXT,workspace_id TEXT,revert TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
    INSERT INTO session_v2 VALUES ('s','/repo','p',NULL,NULL);`)
  db.prepare("INSERT INTO session_message VALUES ('m','s','assistant',1,?)").run(JSON.stringify({content:[{type:"tool",name:"mcp.files",state:{content:Array.from({length:100},(_,n)=>({type:"file",name:String(n),mime:"text/plain",uri:"data:text/plain;base64,YQ=="}))}}]}))
  try {
    const first=await listSessionAssets(db,scope,undefined,signal);if(first.status!=="page")assert.fail()
    assert.equal(first.entries.length,64);assert(first.cursor)
    const next=await listSessionAssets(db,scope,first.cursor!,signal);if(next.status!=="page")assert.fail()
    assert.equal(next.entries.length,36);assert.equal(next.cursor,null)
    assert.equal(new Set([...first.entries,...next.entries].map(value=>value.name)).size,100)
    db.prepare("UPDATE session_v2 SET project_id='q'").run()
    assert.deepEqual(await listSessionAssets(db,{...scope,projectID:"q"},first.cursor!,signal),{status:"blocked",reason:"conflict"})
    db.prepare("UPDATE session_message SET data=?").run(' '.repeat(16*1024*1024+1))
    assert.equal((await listSessionAssets(db,{...scope,projectID:"q"},undefined,signal)).status,"blocked")
    const cancelled=new AbortController();cancelled.abort()
    await assert.rejects(listSessionAssets(db,{...scope,projectID:"q"},undefined,cancelled.signal))
    assert.equal(db.isTransaction,false)
  } finally {db.close()}
})
