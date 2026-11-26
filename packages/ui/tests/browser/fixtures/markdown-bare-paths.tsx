// The real Markdown component with a session context and a stubbed workspace
// listing: bare paths in prose become file-reader links exactly when the path
// exists as a file inside the session's worktree; everything else stays text.
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { Markdown } from "../../../src/components/markdown"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, tGlobal } from "../../../src/lib/i18n"
import { addInstance } from "../../../src/stores/instances"
import { setSessions } from "../../../src/stores/session-state"
import type { Session } from "../../../src/types/session"
import { getFilePreview } from "../../../src/stores/files-preview"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { clearBarePathCaches } from "../../../src/components/markdown-bare-paths"

const id = "markdown-bare-paths", scope = "/fixture-root"
const client = sdkManager.createClient(id, `/workspaces/${id}/instance`, () => true)
serverApi.fetchServerMeta = async () => ({ previewsUnavailable: false }) as never
addInstance({ id, folder: scope, port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client,
  metadata: { project: { id: "project", directory: scope, canonical: scope } } })

let includeGone = false
let holdListing = new URLSearchParams(location.search).has("held")
let released = false
const pendingReleases: Array<() => void> = []
const listingCalls: Array<{ path: string; directory: string | undefined }> = []
type Entry = { name: string; type: string }
const entries = (names: Array<[string, string]>): Entry[] => names.map(([name, type]) => ({ name, type }))
serverApi.listWorkspaceFiles = (async (_id: string, relativePath = ".", directory?: string) => {
  listingCalls.push({ path: relativePath, directory })
  if (holdListing && !released) await new Promise<void>(resolve => { pendingReleases.push(resolve) })
  if (relativePath === "src") return entries([["app.ts", "file"], ["a\tpp.ts", "file"], ["inner", "directory"],
    ...(includeGone ? ([["gone.ts", "file"]] as Array<[string, string]>) : [])])
  if (relativePath === "docs") return entries([["算法工作台MVP-design.md", "file"], ["issue", "file"], ["算.md", "file"]])
  if (relativePath === "前端-v2") return entries([["run-测试", "file"]])
  if (relativePath === "脚本") return entries([["启动", "file"]])
  if (relativePath === "项目/v2") return entries([["启动", "file"]])
  if (relativePath === ".") return entries([["README.md", "file"], ["src", "directory"], ["docs", "directory"], ["设计.md", "file"]])
  if (relativePath === "and") throw new Error("no such directory")
  return []
}) as typeof serverApi.listWorkspaceFiles

const session = { id: "ses_bare", instanceId: id, parentId: null, title: "Bare", agent: "build",
  model: { providerId: "private", modelId: "private" }, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, status: "idle", runtimeStatusKnown: true,
  location: { directory: scope }, time: { created: 1, updated: 1 } } satisfies Session
setSessions(previous => new Map(previous).set(id, new Map([[session.id, session]])))

const initialText = [
  "The fix lives in src/app.ts and src/gone.ts today.",
  "Also see README.md and the old /fixture-root/README.md copy.",
  "Outside the worktree: /etc/passwd. A directory: src/inner.",
  "Prose keeps and/or unclear; inline code links exactly: `src/app.ts`.",
  "看看src/app.ts吧。",
  "A hand-written [readme](./README.md) keeps its own anchor.",
  "规格写入 `./docs/算法工作台MVP-design.md`。",
  "缺的不連：`docs/不存在README.md`；URL `https://example.test/guide#README.md` 也不連。",
  "`前端-v2/run-测试` 存在；`docs/issue#42.md` 與 `docs/%E7%AE%97.md` 保持純文字。",
  "`src/app.ts!` `src/app.ts?` `src/a\tpp.ts` <code>run <em>src/app.ts</em> now</code>",
  "```\nsrc/app.ts\n```",
  "规格写入 docs/算法工作台MVP-design.md，待确认两项。",
  "根目录的 设计.md 也是；对比 src/app.ts和README.md 的差异。",
  "看看README.md.吧。",
  "跑 脚本/启动 前先读。",
  "放进 项目/v2/启动 里。",
  "File:/fixture-root/README.md 也行。",
  "散文裡的 URL https://example.com/资料README.md 也不連到同名檔案。",
  "編碼路徑 docs/%E7%AE%97.md 保持純文字。",
].join("\n\n")

let renderCount = 0
const [partText, setPartText] = createSignal(initialText)
const dispose = render(() => <ConfigProvider><I18nProvider>
  <div id="main-root">
    <Markdown part={{ id: "part", type: "text", version: 0, text: partText() }}
      instanceId={id} sessionId={session.id} onRendered={() => { renderCount++ }} />
  </div>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)

;(window as any).fixture = {
  count: (href: string) => document.querySelectorAll(`#main-root a[href="${CSS.escape(href)}"]`).length,
  codeLinks: () => document.querySelectorAll("#main-root code a").length,
  title: (href: string) => document.querySelector(`#main-root a[href="${CSS.escape(href)}"]`)?.getAttribute("title") ?? null,
  label: (key: string) => tGlobal(key),
  target: () => getFilePreview(id)?.path ?? null,
  rendered: () => renderCount,
  rerender: (text: string) => { setPartText(text) },
  clearCache: () => clearBarePathCaches(),
  addGone: () => { includeGone = true },
  listingCalls: () => [...listingCalls],
  release: () => { released = true; const pending = pendingReleases.splice(0); for (const release of pending) release() },
  initialText,
  dispose,
}
