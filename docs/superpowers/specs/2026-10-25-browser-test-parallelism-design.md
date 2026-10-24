# Browser 測試並行化 + teardown 保護（A+B）設計

日期：2026-10-25 · 狀態：待核准 · 範圍：`packages/ui/tests/browser/`、`packages/ui/package.json`

## 意圖與為什麼

上游 PR 的 `tests` job 佔 1.5–2.2 小時，其中 `test:browser`（Playwright + Vite fixture）
一步就 121 分鐘（PR #1131 實測）。Spike 證實成本結構：

- 每個測試檔自帶一個 Vite dev server，首次頁面載入要逐一轉換整個 app 元件圖（~9–23 秒/檔，與 dep cache 冷熱無關）
- 77/140 檔缺少 `createFixtureShutdown` 保護，大圖檔案 `server.close()` 卡在 optimizer 未結算 ~19 秒
- `--test-concurrency=1` 從 test:browser 誕生（#683）就鎖死；本地 4 路並行實測 1.7× 加速

目標：A（並行）+ B（teardown 保護）把 `test:browser` 從 ~121 分鐘壓到 **~40–70 分鐘**（CI 4 vCPU 估算）。

## 內容

### A — 解除並行

1. `packages/ui/package.json`：`test:browser` 的 `--test-concurrency=1` → `--test-concurrency=4`。
   （`qualify:browser:native-mission-replay` 單檔，維持不變。）
2. 導航預算：並行冷啟動讓首次 `page.goto` 超過 Playwright 預設 30 秒（本地 4 路實測復現，
   drawer-width 31 秒逾時）。新增極小 helper
   `tests/browser/fixture-navigation-budget.ts`：`armFixtureNavigationBudget(browser, ms = 120_000)`
   包裹 `browser.newPage`/`newContext`，對每個新建 page/context 設
   `setDefaultNavigationTimeout(120_000)`。每個 chromium 測試檔在 launch 後加一行呼叫。

### B — 統一 cache + shutdown 標準接線

A **強制** B 的 cache 部分：57 檔目前用預設共享 `node_modules/.vite`，並行下會同時寫入
（AGENTS.md 明令禁止「parallel tests share mutable optimizer output」），必須遷到
per-fixture `createFixtureCache()`。同時把缺 `createFixtureShutdown` 的檔案補上標準接線
（已有 46 檔的既定樣板）：

```ts
const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
server = await createServer({ ..., cacheDir: cache.cacheDir,
  plugins: [shutdown.plugin, solid(), ...] })
shutdown.own(server); await server.listen()
```

遷移對象（Vite server 直開的 118 檔中，尚未完整的 ~72 檔）：
- 29 檔：有 cache、缺 shutdown → 補 shutdown 接線
- ~43 檔：兩者皆缺（含 3 檔固定命名 cacheDir）→ 補齊兩者
- 例外不動：`node:http` fixture 檔（automation-preview、browser-emulation-native、
  header-fixture-diagnostics）、經 helper 已有保護的檔案（device-upload-lifecycle、
  session-aside-harness）、8 個 electron 檔（已有保護，且不需導航預算）

遷移用一次性 codemod 腳本（放 /tmp，不入庫）+ 少量手工修正；唯一多重 server 檔案手工處理。

### 程序化接線檢查：`tests/browser/fixture-wiring.test.ts`

純靜態源碼掃描（毫秒級、不啟動 server），隨 `test:browser` 在 CI 執行。對所有
`tests/browser/*.test.ts` 與建 Vite server 的 helper（含 `fixtures/*.mjs`）斷言：

1. 凡 `import { createServer } from "vite"` 的檔案必須同時具備 `createFixtureShutdown`
   接線（import + `shutdown.plugin` in plugins + `shutdown.own(server)`）與
   `cacheDir: cache.cacheDir`（禁止預設共享 cache 或固定命名 `node_modules/.vite-*`）
2. 凡 `chromium.launch` 的檔案必須呼叫 `armFixtureNavigationBudget(browser)`
3. 顯式豁免清單：`node:http` fixture 檔、electron 檔、檢查自身

它同時是 codemod 的機械驗證（綠燈 = 118 檔全接好）、永久防回歸閘門、以及例外透明化清單。

## 非目標

- D1 單一長駐 server/browser harness（下階段另案）
- C 共享熱 cache（實測僅 ~2 秒/檔，且與並行互斥）
- E CI job 拓撲重構（拆 job/分片）
- 不改任何測試的斷言與 fixture 內容

## 風險與對策

- `shutdown.own()` 有 drain 驗證，會把「以前默默沒關乾淨」的檔案變成明確失敗
  → 全套件驗證時逐一面對；確實無法乾淨關閉的個別檔案保留原狀並記錄原因
- CI 4 vCPU 的 4 路並行記憶體/CPU 壓力 → 120 秒導航預算吸收冷啟動尖峰；本地全套並行先驗證
- Vite 把 `port: 0` 解釋成「5173 起跳自動遞增」——實測並行下埠仍唯一（bind 成功才算數），
  不改埠邏輯

## 驗證

1. 主 checkout 背景跑完整串行 baseline（已啟動）
2. worktree 內完成遷移後，同一機器跑完整 4 路並行套件：必須全綠 + 記錄牆鐘
3. 報告：本地串行 vs 並行實測、CI 推算值；PR 上的 CI run 為最終數字

## 已考慮並排除的做法

- **C 共享熱 cache**：實測每檔僅省 ~2 秒（prebundle 只佔首載 ~10%），且與並行互斥
- **隨機埠**：Vite 自動遞增已保證埠唯一（bind 後 address() 必真），無需多改 256 處
- **vite build + preview（D2）**：dev/prod 時序差異威脅現有 waitForFunction/settle 斷言，風險過高
