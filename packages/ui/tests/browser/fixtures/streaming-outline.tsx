import { serverApi } from "../../../src/lib/api-client"
import { applyUiSettings } from "./ui-settings"

const count = 10_000
const entries = Array.from({ length: count }, (_, seq) => ({
  id: seq >= count - 620 ? `msg_${String(seq - count + 620).padStart(4, "0")}` : `archive_${String(seq).padStart(5, "0")}`,
  seq, type: seq === 0 ? "user" : "assistant", tools: 0, reasoning: 0,
}))
let reads = 0
serverApi.fetchSessionOutline = async (_instance, _session, cursor) => {
  reads++
  const after = cursor?.after ?? -1
  const page = entries.slice(after + 1, after + 513)
  const through = page.at(-1)!.seq
  return { status: "outline", entries: page, total: count,
    checkpoints: [{ after, through, digest: "0".repeat(64), changed: true }],
    cursor: through < count - 1 ? { after: through, through: count - 1 } : null } as any
}
serverApi.fetchOutlinePreviews = async () => ({ status: "previews", entries: [] })
await import("./session")
const source = (window as any).fixture
await source.seedHistory(620)
await applyUiSettings({ locale: "en", showMessageTimeline: true })
;(window as any).outlineFixture = {
  start: () => source.start(), delta: (text: string) => source.delta(text),
  finish: (text: string) => source.end(text),
  locale: (locale: string) => applyUiSettings({ locale }),
  snapshot: () => ({ reads, text: source.snapshot().text, ...(window as any).__outlineWork }),
  reset: () => { (window as any).__outlineWork.calls = 0 },
}
