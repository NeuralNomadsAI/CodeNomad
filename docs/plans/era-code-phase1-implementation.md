# Era Code Integration - Phase 1: Core Migration

## Phase 1 Objective

Make `era-code` the default binary while maintaining backward compatibility with `opencode`.

---

## Task 1.1: Era Binary Detection Service

### Goal
Create a service to detect era-code installation and its configuration.

### File: `packages/server/src/era/detection.ts` (NEW)

```typescript
interface EraBinaryInfo {
  installed: boolean
  path: string | null
  version: string | null
  assetsPath: string | null
}

interface EraAssets {
  agents: string[]
  commands: string[]
  skills: string[]
  plugins: string[]
}

export class EraDetectionService {
  /**
   * Detect if era-code is installed and get its path
   */
  detectBinary(): EraBinaryInfo

  /**
   * Get era-code version
   */
  getVersion(binaryPath: string): string | null

  /**
   * Get path to era assets (~/.era/era-code/opencode)
   */
  getAssetsPath(): string | null

  /**
   * List available era assets
   */
  listAssets(): EraAssets | null

  /**
   * Check if a project has Era initialized
   */
  isProjectInitialized(folder: string): boolean
}
```

### Implementation Steps

1. Create `packages/server/src/era/` directory
2. Implement `which era-code` detection
3. Parse `era-code --version` output
4. Read `~/.era/era-code/manifest.json` for assets
5. Check for `.era/` directory in project folder

### Test Cases (Unit)

- [ ] Detects era-code when installed
- [ ] Returns null when not installed
- [ ] Parses version correctly
- [ ] Lists assets from manifest
- [ ] Detects initialized vs non-initialized projects

---

## Task 1.2: Update Binary Registry

### Goal
Update `BinaryRegistry` to prioritize era-code as default.

### File: `packages/server/src/config/binaries.ts` (MODIFY)

### Changes

```typescript
// Add to constructor
constructor(
  private readonly configStore: ConfigStore,
  private readonly eventBus: EventBus | undefined,
  private readonly logger: Logger,
  private readonly eraDetection: EraDetectionService, // NEW
) {}

// New method
detectAvailableBinaries(): BinaryRecord[] {
  const binaries: BinaryRecord[] = []

  // 1. Check for era-code first
  const eraInfo = this.eraDetection.detectBinary()
  if (eraInfo.installed && eraInfo.path) {
    binaries.push({
      id: 'era-code',
      path: eraInfo.path,
      label: `Era Code ${eraInfo.version || ''}`.trim(),
      version: eraInfo.version,
      isDefault: true,
      source: 'auto-detected',
    })
  }

  // 2. Check for opencode
  const opencodePath = this.detectOpencode()
  if (opencodePath) {
    binaries.push({
      id: 'opencode',
      path: opencodePath,
      label: 'OpenCode',
      isDefault: !eraInfo.installed,
      source: 'auto-detected',
    })
  }

  // 3. Add user-configured binaries
  binaries.push(...this.getUserConfiguredBinaries())

  return binaries
}

// Update resolveDefault
resolveDefault(): BinaryRecord {
  // Priority: user preference > era-code > opencode > fallback
  const config = this.configStore.get()
  const userPreferred = config.preferences.lastUsedBinary

  if (userPreferred) {
    const found = this.getById(userPreferred)
    if (found) return found
  }

  const available = this.detectAvailableBinaries()
  return available[0] ?? this.buildFallbackRecord('opencode')
}
```

### Implementation Steps

1. Add `EraDetectionService` dependency injection
2. Implement `detectAvailableBinaries()`
3. Update `resolveDefault()` priority logic
4. Add `source` field to `BinaryRecord` type
5. Update `mapRecords()` to merge auto-detected with configured

### Test Cases (Unit)

- [ ] Era-code becomes default when installed
- [ ] Falls back to opencode when era-code not installed
- [ ] User preference overrides auto-detection
- [ ] Auto-detected binaries appear in list()

---

## Task 1.3: Era Launch Configuration

### Goal
Configure workspace launches to use era-code assets when available.

### File: `packages/server/src/era/config.ts` (NEW)

```typescript
interface EraLaunchConfig {
  enabled: boolean
  assetsPath: string
  plugins: string[]
  agents: string[]
  commands: string[]
  skills: string[]
}

export class EraConfigService {
  constructor(
    private readonly detection: EraDetectionService,
    private readonly logger: Logger,
  ) {}

  /**
   * Build launch configuration for a workspace
   */
  buildLaunchConfig(folder: string): EraLaunchConfig | null {
    if (!this.detection.detectBinary().installed) {
      return null
    }

    const assetsPath = this.detection.getAssetsPath()
    if (!assetsPath) return null

    const assets = this.detection.listAssets()
    if (!assets) return null

    return {
      enabled: true,
      assetsPath,
      plugins: assets.plugins,
      agents: assets.agents,
      commands: assets.commands,
      skills: assets.skills,
    }
  }

  /**
   * Get environment variables for era-enabled launch
   */
  getLaunchEnvironment(config: EraLaunchConfig): Record<string, string> {
    return {
      OPENCODE_AGENT_PATH: path.join(config.assetsPath, 'agent'),
      OPENCODE_COMMAND_PATH: path.join(config.assetsPath, 'command'),
      OPENCODE_SKILL_PATH: path.join(config.assetsPath, 'skill'),
      OPENCODE_PLUGIN_PATH: path.join(config.assetsPath, 'plugin'),
    }
  }
}
```

### Implementation Steps

1. Create `EraConfigService` class
2. Implement config builder from assets
3. Generate environment variables for OpenCode
4. Add to DI container

### Test Cases (Unit)

- [ ] Returns null when era-code not installed
- [ ] Builds correct paths from assets
- [ ] Environment variables point to correct directories

---

## Task 1.4: Update Workspace Runtime

### Goal
Integrate era configuration into workspace launch.

### File: `packages/server/src/workspaces/runtime.ts` (MODIFY)

### Changes

```typescript
// Update LaunchOptions
interface LaunchOptions {
  workspaceId: string
  folder: string
  binaryPath: string
  environment?: Record<string, string>
  eraConfig?: EraLaunchConfig  // NEW
}

// Update constructor
constructor(
  private readonly eventBus: EventBus,
  private readonly logger: Logger,
  private readonly eraConfigService: EraConfigService, // NEW
) {}

// Update launch method
async launch(options: LaunchOptions): Promise<{ pid: number; port: number }> {
  this.validateFolder(options.folder)

  const args = ["serve", "--port", "0", "--print-logs", "--log-level", "DEBUG"]

  // Build environment with era config if available
  let env = { ...process.env, ...(options.environment ?? {}) }

  if (options.eraConfig?.enabled) {
    const eraEnv = this.eraConfigService.getLaunchEnvironment(options.eraConfig)
    env = { ...env, ...eraEnv }
    this.logger.info(
      { workspaceId: options.workspaceId, eraAssets: options.eraConfig.assetsPath },
      "Launching with Era Code assets"
    )
  }

  // ... rest of launch logic
}
```

### Implementation Steps

1. Add `EraConfigService` to runtime
2. Update `LaunchOptions` interface
3. Merge era environment variables in `launch()`
4. Log era-enabled launches
5. Update workspace manager to pass era config

### Test Cases (Integration)

- [ ] Launches with era env vars when config provided
- [ ] Launches without era env vars when config null
- [ ] Era assets paths are valid

---

## Task 1.5: Era Status API Endpoint

### Goal
Add API endpoint to check era status for current project.

### File: `packages/server/src/server/routes/era.ts` (NEW)

```typescript
// GET /api/era/status
interface EraStatusResponse {
  installed: boolean
  version: string | null
  binaryPath: string | null
  projectInitialized: boolean
  assetsAvailable: boolean
  assets?: {
    agents: number
    commands: number
    skills: number
    plugins: number
  }
}

// Route implementation
export function createEraRoutes(
  detection: EraDetectionService,
  logger: Logger,
): Router {
  const router = Router()

  router.get('/status', (req, res) => {
    const folder = req.query.folder as string | undefined
    const info = detection.detectBinary()
    const assets = detection.listAssets()

    const response: EraStatusResponse = {
      installed: info.installed,
      version: info.version,
      binaryPath: info.path,
      projectInitialized: folder ? detection.isProjectInitialized(folder) : false,
      assetsAvailable: assets !== null,
      assets: assets ? {
        agents: assets.agents.length,
        commands: assets.commands.length,
        skills: assets.skills.length,
        plugins: assets.plugins.length,
      } : undefined,
    }

    res.json(response)
  })

  return router
}
```

### Implementation Steps

1. Create `routes/era.ts` file
2. Implement `/api/era/status` endpoint
3. Register routes in http-server.ts
4. Add request validation

### Test Cases (API)

- [ ] Returns installed: true when era-code exists
- [ ] Returns installed: false when not exists
- [ ] Returns projectInitialized correctly
- [ ] Returns asset counts

---

## Task 1.6: UI Era Status Store

### Goal
Create UI store for era status.

### File: `packages/ui/src/stores/era-status.ts` (NEW)

```typescript
import { createSignal, createResource } from "solid-js"
import { apiClient } from "../lib/api-client"

interface EraStatus {
  installed: boolean
  version: string | null
  projectInitialized: boolean
  assetsAvailable: boolean
  assets?: {
    agents: number
    commands: number
    skills: number
    plugins: number
  }
}

const [eraStatus, { refetch: refetchEraStatus }] = createResource<EraStatus>(
  async () => {
    const response = await apiClient.get('/api/era/status')
    return response.json()
  }
)

export { eraStatus, refetchEraStatus }

// Derived signals
export const isEraInstalled = () => eraStatus()?.installed ?? false
export const isEraProjectInitialized = () => eraStatus()?.projectInitialized ?? false
export const eraVersion = () => eraStatus()?.version ?? null
```

### Implementation Steps

1. Create era-status store
2. Add API client method
3. Create derived signals
4. Export for use in components

### Test Cases (Unit)

- [ ] Fetches status on load
- [ ] Derived signals compute correctly
- [ ] Handles API errors gracefully

---

## Task 1.7: Era Status Badge Component

### Goal
Display era status in settings panel.

### File: `packages/ui/src/components/era-status-badge.tsx` (NEW)

```typescript
import { Component, Show } from "solid-js"
import { isEraInstalled, eraVersion, isEraProjectInitialized } from "../stores/era-status"
import { CheckCircle, XCircle, AlertCircle } from "lucide-solid"

const EraStatusBadge: Component = () => {
  return (
    <div class="era-status-badge">
      <Show when={isEraInstalled()} fallback={<NotInstalledBadge />}>
        <InstalledBadge />
      </Show>
    </div>
  )
}

const InstalledBadge: Component = () => (
  <div class="era-badge era-badge-installed">
    <CheckCircle class="w-4 h-4" />
    <span>Era Code {eraVersion()}</span>
    <Show when={isEraProjectInitialized()}>
      <span class="era-badge-project">Project Enabled</span>
    </Show>
  </div>
)

const NotInstalledBadge: Component = () => (
  <div class="era-badge era-badge-not-installed">
    <XCircle class="w-4 h-4" />
    <span>Era Code Not Installed</span>
  </div>
)

export default EraStatusBadge
```

### Implementation Steps

1. Create component with status display
2. Add CSS styles for badges
3. Integrate into settings panel

### Test Cases (Visual/Playwright)

- [ ] Shows "Installed" badge when era-code exists
- [ ] Shows "Not Installed" badge when missing
- [ ] Shows version number
- [ ] Shows project status

---

## Task 1.8: Settings Panel Integration

### Goal
Add Era section to settings panel.

### File: `packages/ui/src/components/settings-panel.tsx` (MODIFY)

### Changes

```typescript
// Add import
import EraStatusBadge from "./era-status-badge"
import { isEraInstalled, eraVersion } from "../stores/era-status"

// Add Era section in settings panel JSX
<div class="settings-section">
  <h3 class="settings-section-title">Era Code</h3>
  <div class="settings-section-content">
    <EraStatusBadge />
    <Show when={isEraInstalled()}>
      <div class="settings-row">
        <span class="settings-label">Version</span>
        <span class="settings-value">{eraVersion()}</span>
      </div>
      <div class="settings-row">
        <span class="settings-label">Assets</span>
        <span class="settings-value">
          {/* Asset counts */}
        </span>
      </div>
    </Show>
    <Show when={!isEraInstalled()}>
      <p class="settings-hint">
        Install Era Code for governance and enhanced features.
      </p>
    </Show>
  </div>
</div>
```

### Implementation Steps

1. Import era status store and badge
2. Add Era section to settings panel
3. Display status and configuration options
4. Add CSS styles

### Test Cases (Playwright)

- [ ] Era section visible in settings
- [ ] Shows correct installation status
- [ ] Shows version when installed

---

## Phase 1 Playwright Test Suite

### File: `tests/e2e/EC-010-era-status.spec.ts` (NEW)

```typescript
import { test, expect } from '@playwright/test'

test.describe('EC-010: Era Code Status', () => {
  test('shows era status in settings panel', async ({ page }) => {
    await page.goto('http://localhost:5173')

    // Open settings
    await page.click('[data-testid="settings-button"]')

    // Find Era section
    const eraSection = page.locator('.settings-section:has-text("Era Code")')
    await expect(eraSection).toBeVisible()

    // Check for status badge
    const badge = eraSection.locator('.era-status-badge')
    await expect(badge).toBeVisible()
  })

  test('displays correct era installation status', async ({ page }) => {
    await page.goto('http://localhost:5173')
    await page.click('[data-testid="settings-button"]')

    // Should show installed or not installed
    const eraSection = page.locator('.settings-section:has-text("Era Code")')
    const badge = eraSection.locator('.era-badge')

    // Badge should have one of these classes
    const hasInstalled = await badge.locator('.era-badge-installed').count()
    const hasNotInstalled = await badge.locator('.era-badge-not-installed').count()

    expect(hasInstalled + hasNotInstalled).toBe(1)
  })
})
```

---

## Implementation Order

1. **Task 1.1**: Era Detection Service (foundation)
2. **Task 1.3**: Era Config Service (depends on 1.1)
3. **Task 1.2**: Update Binary Registry (depends on 1.1)
4. **Task 1.4**: Update Workspace Runtime (depends on 1.2, 1.3)
5. **Task 1.5**: Era Status API (depends on 1.1)
6. **Task 1.6**: UI Era Status Store (depends on 1.5)
7. **Task 1.7**: Era Status Badge Component (depends on 1.6)
8. **Task 1.8**: Settings Panel Integration (depends on 1.7)
9. **Playwright Tests**: Validate all components

---

## Validation Checklist

After Phase 1 completion:

- [ ] `era-code` is auto-detected when installed
- [ ] `era-code` becomes default binary when installed
- [ ] `opencode` is used as fallback when era-code not installed
- [ ] User can see Era status in settings panel
- [ ] Workspace launches include era assets when available
- [ ] API returns correct era status
- [ ] All Playwright tests pass
- [ ] No regressions in existing functionality

---

## Estimated Effort

| Task | Effort |
|------|--------|
| 1.1 Era Detection | 2 hours |
| 1.2 Binary Registry | 2 hours |
| 1.3 Era Config | 1.5 hours |
| 1.4 Runtime Update | 1.5 hours |
| 1.5 Status API | 1 hour |
| 1.6 UI Store | 1 hour |
| 1.7 Badge Component | 1 hour |
| 1.8 Settings Integration | 1 hour |
| Playwright Tests | 2 hours |
| **Total** | **~13 hours** |
