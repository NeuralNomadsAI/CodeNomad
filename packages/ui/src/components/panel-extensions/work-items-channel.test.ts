import assert from "node:assert/strict"
import { it } from "node:test"
import { createRoot } from "solid-js"

import { panelExtensionsApi } from "../../lib/panel-extensions-api.ts"
import { useWorkItemsChannel } from "./work-items-channel.ts"

it("opens at most one forge page at a time and once a second, however late the page addresses arrive", async () => {
  const opened: string[] = [], sent: Array<{ id: number; error?: boolean; result?: unknown }> = []
  const answers: Array<(url: string) => void> = []
  const originalUrl = panelExtensionsApi.workItemUrl
  const originalWindow = globalThis.window
  ;(globalThis as any).window = { open: (url: string) => { opened.push(url); return null } }
  panelExtensionsApi.workItemUrl = () => new Promise(resolve => { answers.push(url => resolve({ url })) })
  const { receive, dispose } = createRoot(dispose => ({
    receive: useWorkItemsChannel({ instanceId: "i", id: "a.b", digest: "d".repeat(64), send: value => sent.push(value as any) }), dispose,
  }))
  const open = (id: number, number: number) => receive({ type: "workItems:request", id, method: "open", input: { kind: "issue", number } })
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    // Requests spaced over a second whose page addresses arrive together must not open a burst of tabs.
    const pending = [open(1, 10)]
    now += 1_001
    pending.push(open(2, 11))
    now += 1_001
    pending.push(open(3, 12))
    await Promise.resolve()
    for (const answer of answers) answer(`https://github.com/o/r/issues/${10 + answers.indexOf(answer)}`)
    await Promise.all(pending)
    assert.deepEqual(opened, ["https://github.com/o/r/issues/10"])
    assert.deepEqual(sent.filter(message => message.error).map(message => message.id).sort(), [2, 3])
    now += 500
    await open(4, 13)
    assert.deepEqual(sent.at(-1), { type: "workItems:result", id: 4, error: true }, "within a second of the last opening")
    now += 1_001
    const last = open(5, 14)
    await Promise.resolve()
    answers.at(-1)!("https://github.com/o/r/issues/14")
    await last
    assert.deepEqual(opened, ["https://github.com/o/r/issues/10", "https://github.com/o/r/issues/14"])
  } finally {
    Date.now = realNow
    dispose()
    panelExtensionsApi.workItemUrl = originalUrl
    ;(globalThis as any).window = originalWindow
  }
})
