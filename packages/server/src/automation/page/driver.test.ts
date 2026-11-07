import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { parsePageOperation, pageEnvelope } from "./operations"
import { cdpSession, executeCdpOperation } from "./cdp-driver"
import { nativeDriver } from "./native-driver"
import { declaration, ELEMENT_FUNCTIONS, GLOBAL_FUNCTIONS, nativeFunctionRegistry } from "./functions"
import { PageDriverUnsupportedError, type PageChannel } from "./protocol"
import { renderSnapshot, type AxNode } from "./snapshot"
import { snapshotPage } from "./actions"
import { RefTable } from "./refs"
const json = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"))
const golden = json("./driver.golden.json")

test("the shared fixed registry keeps every pre-driver program byte-identical", () => {
  const hash = (source: string) => createHash("sha256").update(source).digest("hex")
  for (const id of Object.keys(ELEMENT_FUNCTIONS) as (keyof typeof ELEMENT_FUNCTIONS)[]) {
    assert.equal(hash(declaration(id, false)), golden.functions[id].plain, id)
    assert.equal(hash(declaration(id, true)), golden.functions[id].marked, `${id} application mark`)
  }
  for (const [id, source] of Object.entries(GLOBAL_FUNCTIONS)) assert.equal(hash(source), golden.globals[id], id)
  assert.deepEqual(json("./functions.generated.json"), nativeFunctionRegistry(), "regenerate the checked-in native resource when programs change")
})

test("closed driver contract refuses unknown operations, params, programs and malformed arguments", () => {
  const corpus = json("./contract.cases.json")
  for (const operation of corpus.valid) assert.deepEqual(parsePageOperation(operation), operation)
  for (const operation of corpus.invalid) assert.throws(() => parsePageOperation(operation), /Unsupported or invalid/, JSON.stringify(operation))
  assert.throws(() => parsePageOperation({op:"insert-text",text:"x".repeat(256*1024)}), /parameters/)
  assert.throws(() => pageEnvelope("browser.page.send", {sessionID:"s",operationID:"o",generation:"g",method:"Runtime.evaluate",params:{expression:"evil()"}}))
  assert.throws(() => pageEnvelope("browser.page.begin", {sessionID:"s",operationID:"o",driver:"cdp"}))
})

test("CDP snapshots, scoped refs and bounded rendering equal the pre-driver goldens", async () => {
  const nodes: AxNode[] = json("./driver.fixture.json")
  for (const [name, options] of Object.entries({all:{},query:{query:"plan"},scoped:{rootBackendNodeId:14},bounded:{budget:200}})) {
    let before = 0
    assert.deepEqual(renderSnapshot(nodes, () => `b1e${++before}`, options), golden.snapshots[name])
    const calls: string[] = []
    const channel: PageChannel = {send: async method => { calls.push(method); return {nodes} }}
    const session = cdpSession(channel, async () => {}, false)
    const refs = new RefTable("inspect", "b1e")
    assert.deepEqual(await snapshotPage(session, () => refs.issuer("document"), options), golden.snapshots[name])
    assert.deepEqual(calls, ["Accessibility.getFullAXTree"])
    const transport = nativeDriver({driver:"cdp",contractVersion:1}, operation => executeCdpOperation(channel, operation), async () => {})
    const other = new RefTable("inspect", "b1e")
    assert.deepEqual(await snapshotPage({driver:transport,markAutomation:false,checkpoint:async()=>{}}, () => other.issuer("document"), options), golden.snapshots[name])
  }
})

test("WebKit's versioned skeleton returns a typed unsupported error without CDP or DOM fallback", async () => {
  assert.throws(() => nativeDriver({driver:"cdp",contractVersion:2}, async()=>({}), async()=>{}), /contract/)
  assert.throws(() => nativeDriver({}, async()=>({}), async()=>{}), /contract/)
  const calls: unknown[] = []
  const driver = nativeDriver({driver:"webkit",contractVersion:1}, async operation => {
    calls.push(operation)
    return {error:{code:"unsupported",driver:"webkit",operation:operation.op}}
  }, async()=>{})
  await assert.rejects(driver.tree(), error => error instanceof PageDriverUnsupportedError && error.code === "unsupported" && error.driver === "webkit" && error.operation === "tree")
  await assert.rejects(driver.insertText("é漢🙂"), PageDriverUnsupportedError)
  assert.deepEqual(calls,[{op:"tree"},{op:"insert-text",text:"é漢🙂"}])
  await assert.rejects(driver.call("mark-input",undefined,[]), /parameters/)
})
