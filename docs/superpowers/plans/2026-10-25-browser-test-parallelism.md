# Browser 測試並行化 + teardown 保護 實作計劃

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `test:browser`（~121 分鐘 CI）透過 4 路並行 + 全檔案 `createFixtureCache`/`createFixtureShutdown` 標準接線壓到 ~40–70 分鐘，並以靜態接線檢查永久防回歸。

**Architecture:** 三件事互相咬合：(1) 導航預算 helper 吸收並行冷啟動的首次載入延遲；(2) 一次性 codemod 把 72 個缺接線的 Vite 測試檔補齊既有 46 檔的標準樣板（per-fixture cache 是並行安全的前提）；(3) 靜態 wiring 檢查作為 codemod 的機械驗證與 CI 防回歸閘門。最後 `--test-concurrency=1` → `4`。

**Tech Stack:** Node test runner（`node --test`）、Playwright 1.63（raw library，無 @playwright/test）、Vite 5 dev server、tsx。

**Spec:** `docs/superpowers/specs/2026-10-25-browser-test-parallelism-design.md`

## Global Constraints

- 主 checkout（`/home/wan/work/Project/opensource/CodeNomad`）在背景 baseline 跑完前**不得編輯**；所有工作在 worktree 進行
- worktree 位於 `/home/wan/work/Project/opensource/CodeNomad/.codenomad/worktrees/browser-test-parallelism`，分支 `perf/browser-test-parallelism` 自 dev HEAD
- AGENTS.md：並行測試不得共享可變 optimizer 輸出；絕不清除 checkout 共享 cache（`node_modules/.vite`）
- 導航預算預設 `120_000` ms；並行度 `4`；`qualify:browser:native-mission-replay` script 不動
- 已正確接線的 46 檔**零 diff**（它們是參考樣板；codemod 不得改動它們）
- Commit：conventional subject + body（緣由/行為/驗證）

## Review Focus

- 新測試檔將來漏接線 → wiring 檢查必須紅燈並列檔名（Task 3 的測試就是它自身的證明）
- 並行冷啟動首次 `goto` 超 Playwright 預設 30s → 每個 chromium 檔必須 arm 預算（Task 2 行為測試：小預算下掛死伺服器 goto 快速逾時）
- 並行 Vite server 共寫 `node_modules/.vite` → wiring 規則強制 `cacheDir: *.cacheDir`（Task 3/4）
- `shutdown.own()` drain 驗證把「從前默默關不乾淨」的檔案變顯性失敗 → 全套並行驗證逐一面對；真無法乾淨關閉者記錄於 wiring 檢查豁免清單並註明原因（Task 6）
- budget wrapper 吃掉 `newPage`/`newContext` 的 options → Task 2 行為測試斷言 options 照常生效

---

### Task 1: Worktree bootstrap

**Files:**
- Modify（worktree 內提交）: `docs/superpowers/specs/2026-10-25-browser-test-parallelism-design.md`、`docs/superpowers/plans/2026-10-25-browser-test-parallelism.md`（自主 checkout 複製，不回寫主 checkout）

- [ ] **Step 1: 建 worktree 與分支**

```bash
git worktree add /home/wan/work/Project/opensource/CodeNomad/.codenomad/worktrees/browser-test-parallelism -b perf/browser-test-parallelism dev
```

- [ ] **Step 2: 安裝依賴（背景，約 2–4 分鐘）**

Run: `npm ci`（worktree 根目錄）
Expected: 完成、無 error

- [ ] **Step 3: 複製設計文件與本計劃進 worktree 並提交**

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp /home/wan/work/Project/opensource/CodeNomad/docs/superpowers/specs/2026-10-25-browser-test-parallelism-design.md docs/superpowers/specs/
cp /home/wan/work/Project/opensource/CodeNomad/docs/superpowers/plans/2026-10-25-browser-test-parallelism.md docs/superpowers/plans/
```
（分別放到 specs/ 與 plans/）commit：`docs(superpowers): browser-test parallelism design and plan`

### Task 2: 導航預算 helper（TDD）

**Files:**
- Create: `packages/ui/tests/browser/fixture-navigation-budget.ts`
- Test: `packages/ui/tests/browser/fixture-navigation-budget.test.ts`

**Interfaces:**
- Produces: `armFixtureNavigationBudget(browser: Browser, timeout?: number): void`——冪等；包裹 `browser.newPage` 與 `browser.newContext`，對每個新建 page/context 呼叫 `setDefaultNavigationTimeout(timeout)`（預設 `120_000`），options 原樣透傳

- [ ] **Step 1: 寫失敗的行為測試**

測試內容：(a) 啟動 chromium + 一個「接受連線但不回應」的 `node:http` server；(b) `armFixtureNavigationBudget(browser, 500)`；(c) `page.goto(url)` 必須在 5 秒內以 `TimeoutError` reject（證明預算已掛上）；(d) `browser.newContext({ viewport })` 建 context → page 同樣快速逾時；(e) 未 arm 前建立的 page 不受影響（對照組，用短 timeout 斷言行為差異或直接省略——以 (c)(d) 為準）；(f) options 透傳：armed 後 `newPage`/`newContext` 回傳正常實例（可 `page.close()`）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/ui && node --import tsx --test tests/browser/fixture-navigation-budget.test.ts`
Expected: FAIL（`armFixtureNavigationBudget` 不存在）

- [ ] **Step 3: 實作 helper**

`export function armFixtureNavigationBudget(browser: Browser, timeout = 120_000): void`——保存原 `newPage`/`newContext`，替換為先建、再 `setDefaultNavigationTimeout(timeout)`、回傳原生物。型別用 Playwright 的 `Browser`、`Page`、`BrowserContext`。檔案 ≤ 30 行。

- [ ] **Step 4: 跑測試確認通過**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: Commit**

`test(ui): add fixture navigation budget helper for parallel cold starts`（body 說明 4 路並行下首次載入會超 30s 預設導航逾時的實測）

### Task 3: 靜態接線檢查（先紅燈）

**Files:**
- Test: `packages/ui/tests/browser/fixture-wiring.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `armFixtureNavigationBudget` 名稱（規則 3 引用）
- Produces: 三條規則 + 顯式豁免清單常數（空或僅含具名理由）

- [ ] **Step 1: 寫檢查測試**

掃描 `tests/browser/` 的 `*.test.ts`、`*.ts` 與 `fixtures/*.mjs`（排除自身）：
1. `import.*createServer.*from "vite"` 的檔案必須含 `createFixtureShutdown` import、`shutdown.plugin`、`shutdown.own(`，且 `cacheDir:` 指到 `*.cacheDir`（禁止 `node_modules/.vite` 字樣或無 cacheDir）
2. `createServer.*vite` 檔案必須含 `createFixtureCache` 呼叫
3. 含 `chromium.launch` 的檔案必須含 `armFixtureNavigationBudget(`
豁免清單：具名檔案 + 一行理由（預期為空或近空）。失敗訊息逐檔列出缺項。

- [ ] **Step 2: 跑檢查確認失敗且清單正確**

Run: `cd packages/ui && node --import tsx --test tests/browser/fixture-wiring.test.ts`
Expected: FAIL，列出約 72 個 Vite 檔缺 shutdown/cache 接線、約 110 個 chromium 檔缺 budget；46 個已接線檔**不在**清單中

- [ ] **Step 3: Commit（紅燈狀態不 commit；此檔與 codemod 同一 commit 於 Task 4 落地）**

### Task 4: Codemod 遷移 72 檔

**Files:**
- Modify: `packages/ui/tests/browser/` 下約 72 個 `.test.ts`（29 檔補 shutdown、~43 檔補 cache+shutdown+固定 cacheDir 移除）、可能 1 個多重 server 檔手工處理
- 一次性腳本放 `/tmp/opencode/codemod-fixture-wiring.mjs`（不入庫）

**Interfaces:**
- Consumes: `createFixtureCache`、`createFixtureShutdown`、`armFixtureNavigationBudget`
- Produces: 全部 Vite 測試檔符合 Task 3 三條規則；46 個參考檔零 diff

- [ ] **Step 1: 寫 codemod（對每個 `await createServer({` 檔案）**

轉換規則：
- 缺 `createFixtureCache` import → 加 `import { createFixtureCache } from "./fixture-cache"`（fixtures/*.mjs 用相對路徑 `../fixture-cache.ts`）；缺 `createFixtureShutdown` import 同理
- `await createServer({` 前插一行 `const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)`（已存在具名 cache 變數者沿用其名）
- createServer opts 缺 `cacheDir:` → 在 `logLevel: "error",` 後插 `cacheDir: cache.cacheDir,`；`cacheDir: "node_modules/.vite*"` → 換成 `cacheDir: cache.cacheDir`
- `plugins: [` → `plugins: [shutdown.plugin, `
- 第一個 `await server.listen()` 前插 `shutdown.own(server)`
- `browser = await chromium.launch(` 行後插 `armFixtureNavigationBudget(browser)`，並補 `import { armFixtureNavigationBudget } from "./fixture-navigation-budget"`（fixtures/*.mjs 用相對路徑）；無此形狀者手工
- 檔內多個 Vite server：每個 server 配對自己的 cache/shutdown（變數名加後綴）；此類檔手工處理

- [ ] **Step 2: 執行並驗證零汙染**

Run: `node /tmp/opencode/codemod-fixture-wiring.mjs`（worktree 內）
然後 `git diff --stat`：46 個參考檔不得出現；`git status` 顯示約 72–75 個修改檔

- [ ] **Step 3: wiring 檢查轉綠**

Run: `cd packages/ui && node --import tsx --test tests/browser/fixture-wiring.test.ts`
Expected: PASS（不綠 → 依清單手工補）

- [ ] **Step 4: typecheck**

Run: `cd packages/ui && npm run typecheck`
Expected: PASS（tests 在 tsconfig 範圍內則涵蓋；不在則以 tsx 載入全檔無錯代替：`node --import tsx --test tests/browser/fixture-wiring.test.ts` 已含語法檢查，另抽 5 個被改檔單跑確認可載入）

- [ ] **Step 5: 抽樣行為驗證（被改檔真的能跑）**

Run: `node --import tsx --test tests/browser/alert-dialog.test.ts tests/browser/appearance.test.ts tests/browser/full-source-copy.test.ts`
Expected: 全 PASS（含 teardown 秒退、`fixture-shutdown` JSON log 出現）

- [ ] **Step 6: Commit**

`test(ui): wire every vite fixture with an owned cache and protected shutdown`（body：並行安全前提、codemod 手段、wiring 檢查落地）

### Task 5: 解除並行 + 煙囪測試

**Files:**
- Modify: `packages/ui/package.json:11`

- [ ] **Step 1: 改 script**

`"test:browser": "node --import tsx --test --test-concurrency=4 tests/browser/*.test.ts"`（qualify 行不動）

- [ ] **Step 2: 重跑先前並行失敗的 4 檔組合**

Run: `cd packages/ui && node --import tsx --test --test-concurrency=4 tests/browser/alert-dialog.test.ts tests/browser/brand-logo.test.ts tests/browser/drawer-accessibility.test.ts tests/browser/drawer-width.test.ts`
Expected: 全 PASS（原先 drawer-width 31s 導航逾時不復現）

- [ ] **Step 3: Commit**

`test(ui): run browser fixtures four-wide`（body：本地 4 檔 1.7×、120s 預算與 per-fixture cache 的前提）

### Task 6: 全套並行驗證 + 測速報告（阻擋於背景 baseline 完成）

**Files:**
- 無新檔；產出 `/tmp/opencode/parallel-run.log` 與對比數據

- [ ] **Step 1: 確認背景串行 baseline 已完成**（`/tmp/opencode/serial-baseline.log` 有 `SERIAL_TOTAL_WALL`）

- [ ] **Step 2: worktree 跑完整並行套件**

Run: `cd <worktree>/packages/ui && /usr/bin/time -f "PARALLEL_TOTAL_WALL %e s" npm run test:browser > /tmp/opencode/parallel-run.log 2>&1`
Expected: 全綠（140 檔 + wiring + budget 測試）；記錄牆鐘。任何 drain 失敗：逐檔診斷，屬「確實無法乾淨關閉」者回報並加豁免＋理由，不得靜默繞過

- [ ] **Step 3: 彙報數據**

本地串行 vs 並行牆鐘、加速比、CI（4 vCPU）推算、failures 處置；PR 上的 CI run 為最終數字

- [ ] **Step 4: Commit（如有豁免調整）＋ 彙報**
