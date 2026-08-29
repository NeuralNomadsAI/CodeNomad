import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

test("CLI event disposers remove only their own wrapper listeners", () => {
  const listeners = new Map<string, Set<Function>>()
  let api: Record<string, Function> | undefined
  const ipcRenderer = {
    on(channel: string, listener: Function) {
      const channelListeners = listeners.get(channel) ?? new Set()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    },
    removeListener(channel: string, listener: Function) { listeners.get(channel)?.delete(listener) },
    invoke() {},
  }
  vm.runInNewContext(readFileSync(new URL("./index.cjs", import.meta.url), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld(name: string, value: Record<string, Function>) { if (name === "electronAPI") api = value } },
      ipcRenderer,
      webUtils: {},
    }),
    process: { argv: [] },
  })

  for (const [subscribe, channel] of [
    ["onCliStatus", "cli:status"],
    ["onCliError", "cli:error"],
    ["onDeveloperRunStatus", "developer-run:status"],
    ["onDeveloperRunLog", "developer-run:log"],
  ] as const) {
    const calls: string[] = []
    const disposeFirst = api![subscribe]((value: string) => calls.push(`first:${value}`))
    api![subscribe]((value: string) => calls.push(`second:${value}`))
    disposeFirst()
    for (const listener of listeners.get(channel) ?? []) listener({}, "event")
    assert.deepEqual(calls, ["second:event"])
  }
})
