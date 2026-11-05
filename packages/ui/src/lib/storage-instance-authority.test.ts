import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { serverApi } from "./api-client"
import { serverEvents } from "./server-events"
import { ServerStorage } from "./storage"

const original = { readInstanceData: serverApi.readInstanceData, writeInstanceData: serverApi.writeInstanceData, deleteInstanceData: serverApi.deleteInstanceData }
afterEach(() => Object.assign(serverApi, original))
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const data = (label: string) => ({ messageHistory: [label], agentModelSelections: {} })
test("incoming instance snapshot fences a pending GET including equal-valued publication", async () => {
  const store = new ServerStorage(), gate = deferred<any>(), seen: string[] = []
  serverApi.readInstanceData = () => gate.promise
  const stop = store.onInstanceDataChanged("read-event", value => seen.push(value.messageHistory[0]))
  const read = store.loadInstanceData("read-event")
  ;(serverEvents as any).dispatch({ type: "instance.dataChanged", instanceId: "read-event", data: data("authority") })
  gate.resolve(data("old-get"))
  assert.deepEqual(await read, data("authority"))
  assert.deepEqual(seen, ["authority"])
  stop()
})
test("an intervening event during an acknowledged write requires bounded authoritative read rather than incoming-wins", async () => {
  const store = new ServerStorage(), gate = deferred(), seen: string[] = []
  let persisted = data("initial"), reads = 0, writes = 0
  serverApi.readInstanceData = async () => { reads++; return structuredClone(persisted) }
  serverApi.writeInstanceData = async (_id, value) => { writes++; await gate.promise; persisted = structuredClone(value) }
  await store.loadInstanceData("write-event")
  const stop = store.onInstanceDataChanged("write-event", value => seen.push(value.messageHistory[0]))
  const write = store.saveInstanceData("write-event", data("committed"))
  ;(serverEvents as any).dispatch({ type: "instance.dataChanged", instanceId: "write-event", data: data("earlier-event") })
  gate.resolve(); await write
  assert.equal(persisted.messageHistory[0], "committed")
  assert.deepEqual(await store.loadInstanceData("write-event"), data("committed"))
  assert.equal(reads, 2, "one authoritative read resolves the HTTP/event ambiguity")
  assert.equal(writes, 1)
  assert.deepEqual(seen, ["initial", "earlier-event", "committed"])
  stop()
})
test("a late delete ACK cannot clear a newer write's accepted snapshot", async () => {
  const store = new ServerStorage(), gate = deferred()
  let persisted = data("initial")
  serverApi.readInstanceData = async () => structuredClone(persisted)
  serverApi.writeInstanceData = async (_id, value) => { persisted = structuredClone(value) }
  serverApi.deleteInstanceData = async () => { persisted = data(""); await gate.promise }
  await store.loadInstanceData("delete-write")
  const deletion = store.deleteInstanceData("delete-write")
  await store.saveInstanceData("delete-write", data("new"))
  gate.resolve(); await deletion
  assert.deepEqual(persisted, data("new"))
  assert.deepEqual(await store.loadInstanceData("delete-write"), data("new"))
})

test("an equal-valued authoritative event still fences an older write ACK", async () => {
  const store = new ServerStorage(), gate = deferred()
  let persisted = data("initial"), reads = 0
  serverApi.readInstanceData = async () => { reads++; return structuredClone(persisted) }
  serverApi.writeInstanceData = async (_id, value) => { persisted = structuredClone(value); await gate.promise }
  await store.loadInstanceData("equal-event")
  const write = store.saveInstanceData("equal-event", data("requested"))
  persisted = data("initial")
  ;(serverEvents as any).dispatch({ type: "instance.dataChanged", instanceId: "equal-event", data: structuredClone(persisted) })
  gate.resolve(); await write
  assert.deepEqual(persisted, data("initial"), "a separate server mutation is authoritative")
  assert.deepEqual(await store.loadInstanceData("equal-event"), data("initial"))
  assert.equal(reads, 2)
})

test("retiring an old instance-data subscription twice leaves the replacement listener attached", () => {
  const store = new ServerStorage(), values: string[] = []
  const old = store.onInstanceDataChanged("subscription-owner", () => {})
  old()
  const current = store.onInstanceDataChanged("subscription-owner", value => values.push(value.messageHistory[0]))
  old()
  ;(serverEvents as any).dispatch({ type: "instance.dataChanged", instanceId: "subscription-owner", data: data("current") })
  assert.deepEqual(values, ["current"])
  current()
})
