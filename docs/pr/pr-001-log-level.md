# PR: Add log level configuration support

## 概述
本 PR 為 CodeNomad 添加了日誌等級配置功能，允許用戶通過配置文件或 UI 界面控制 OpenCode 實例的日誌輸出級別。

## 主要變更

### 1. 配置 Schema 更新 (`packages/server/src/config/schema.ts`)
- 在 `PreferencesSchema` 中添加 `logLevel` 字段
- 支援的值：`"DEBUG"`, `"INFO"`, `"WARN"`, `"ERROR"`
- 預設值：`"DEBUG"`（與原始硬編碼行為一致）

### 2. 後端運行時更新
- **`packages/server/src/workspaces/runtime.ts`**:
  - 擴展 `LaunchOptions` 接口，添加可選的 `logLevel` 屬性
  - 動態構建 `--log-level` 參數，使用配置值或預設值 `"DEBUG"`
  - 確保值轉換為大寫格式以匹配 OpenCode CLI 要求

- **`packages/server/src/workspaces/manager.ts`**:
  - 從配置的 `preferences.logLevel` 讀取日誌級別
  - 將 `logLevel` 傳遞給 `runtime.launch()` 選項

### 3. 配置管理 API (`packages/ui/src/stores/preferences.tsx`)
- 新增 `updateLogLevel(level: string)` 函數
- 使用 `patchConfigOwner("server", { preferences: { logLevel } })` 更新服務器配置
- 集成到 `ConfigContextValue` 接口和 `useConfig` 鉤子

### 4. UI 設置界面 (`packages/ui/src/components/settings/opencode-settings-section.tsx`)
- 新增「Log level」設定卡片
- 下拉選擇器直接顯示設定值（DEBUG、INFO、WARN、ERROR）
- 使用 `updateLogLevel` 函數更新配置
- 預設值顯示為 `"DEBUG"`

### 5. 國際化支援 (`packages/ui/src/lib/i18n/messages/en/settings.ts`)
- 新增翻譯字符串：
  - `settings.opencode.logLevel.title`: "Log level"
  - `settings.opencode.logLevel.subtitle`: "Set the log level for OpenCode instances (debug, info, warn, error)."

### 6. 文檔更新 (`docs/config-api.md`)
- 詳細記錄 `patchConfigOwner` 機制
- 配置架構分析（UI 配置 vs 服務器配置）
- 新設置集成指南

## 配置文件結構

### 新增配置選項
```yaml
# ~/.config/codenomad/config.yaml
preferences:
  logLevel: "DEBUG"  # 可選值: "DEBUG", "INFO", "WARN", "ERROR"
```

### 完整配置示例
```yaml
ui:
  settings:
    theme: "dark"
    locale: "zh-TW"

server:
  opencodeBinary: "/usr/local/bin/opencode"
  preferences:
    logLevel: "DEBUG"  # 新增的日誌等級配置
  environmentVariables:
    NODE_ENV: "production"
```

## 工作流程

### 配置更新流程
```
UI 下拉選擇 → updateLogLevel("INFO")
    ↓
patchConfigOwner("server", { preferences: { logLevel: "INFO" } })
    ↓
HTTP PATCH → /api/storage/config/server
    ↓
服務器更新 config.yaml
    ↓
新工作區啟動時讀取 logLevel
    ↓
CLI 參數: --log-level INFO
```

### 向後相容性
- **未配置時**：使用預設值 `"DEBUG"`，與原始硬編碼行為完全一致
- **現有配置**：無需修改，系統會自動使用預設值
- **值格式**：自動轉換為大寫，符合 OpenCode CLI 要求

## 測試驗證

### 手動測試步驟
1. **配置驗證**：
   ```bash
   cat ~/.config/codenomad/config.yaml | grep logLevel
   ```

2. **UI 測試**：
   - 打開設置介面 → OpenCode → Log level
   - 選擇不同的日誌級別
   - 驗證配置是否保存到文件

3. **CLI 參數驗證**：
   - 創建新工作區
   - 檢查啟動日誌中是否包含 `--log-level DEBUG/INFO/WARN/ERROR`

### 自動化測試
```bash
# 運行類型檢查
pnpm run typecheck

# 構建項目
pnpm run build
```

## 相關文檔
- [配置管理 API 機制分析](../config-api.md)
- [OpenCode CLI 參考文檔](https://opencode.ai/docs/zh-tw/cli/)

## 注意事項
- **即時生效**：僅對新啟動的實例生效，現有實例需要重啟
- **錯誤處理**：配置更新失敗會記錄到日誌但不會阻止 UI 操作
- **默認值**：保持 `"DEBUG"` 以確保向後相容性
- **值驗證**：使用 Zod schema 驗證，確保值符合預期

## 檔案變更摘要
```
packages/server/src/config/schema.ts          (新增 logLevel 字段)
packages/server/src/workspaces/manager.ts     (讀取並傳遞 logLevel)
packages/server/src/workspaces/runtime.ts     (動態構建 --log-level 參數)
packages/ui/src/components/settings/opencode-settings-section.tsx (UI 設置界面)
packages/ui/src/lib/i18n/messages/en/settings.ts (國際化字符串)
packages/ui/src/stores/preferences.tsx        (updateLogLevel 函數)
docs/config-api.md                            (API 文檔)
```