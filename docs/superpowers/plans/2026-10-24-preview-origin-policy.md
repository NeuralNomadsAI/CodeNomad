# Preview Origin Policy and Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make preview origin and iframe permissions explicit, server-enforced settings, default to opaque previews, and close the loopback/CSP/comment-bridge security gaps.

**Architecture:** Add a normalized `server.preview` policy (origin mode, custom origin, sandbox flags, delegated browser features). The server computes the CSP sandbox from the policy and the request's browser-visible origin; the UI uses the same policy for the iframe source, sandbox, `allow` attribute and message-origin check. A custom origin is an operator-routed reverse-proxy origin; desktop capability-host previews keep their isolated per-token origin.

**Tech Stack:** TypeScript, Fastify/`@fastify/reply-from`, SolidJS, node:test + tsx, Playwright/Vite browser fixtures, YAML settings.

**Spec:** `docs/superpowers/specs/2026-10-24-preview-origin-policy-design.md`

## Global Constraints

- Default preview policy: `originMode: "opaque"`, empty `customOrigin`, sandbox `{ forms: true, modals: true, popups: true, downloads: true }`, every browser feature false.
- `allow-scripts` is always present in the preview sandbox; `allow-same-origin` is added only by the origin policy.
- Loopback matching is strict: `localhost`, `0.0.0.0`, `::1`, `[::1]`, and full IPv4 `127.x.y.z` literals only. `127.evil.com` and `127.0.0.1.example.com` are not loopback.
- Custom origins must be absolute HTTP(S) origins with no credentials/path/search/hash, a distinct hostname from every CodeNomad origin, and must be routed by the operator to `/previews/*` (including WebSocket) with `Host` preserved. Root-relative resources that bypass the rewritten preview namespace are unsupported at a custom origin.
- The server is authoritative for origin mode and sandbox flags. UI settings are a projection of `server.preview`; browser site settings and prompts remain the final authority for browser features.
- No new-window/pop-out behavior in this plan.
- Native Electron and Windows Tauri webviews keep their existing permission/download/popup behavior; iframe toggles apply to embedded iframe previews (including Tauri Linux capability-host iframes). Desktop local previews keep their per-token capability-host origin.
- No user-visible hard-coded strings; add every new key to every locale and update the affected help pages in all ten locales.
- Test commands: `cd packages/server && node --import tsx --test <files>`, `cd packages/ui && node --import tsx --test <files>`, `npm run typecheck --workspace @neuralnomads/codenomad`, `npm run typecheck --workspace @codenomad/ui`, `npm run test:help`.

## Review Focus

- A hostname beginning with `127.` but not a full IPv4 loopback literal must never receive loopback trust (Tasks 1, 3, 4).
- In custom mode, the same preview token served at the app origin must remain opaque; only requests at the configured custom `Host` may receive `allow-same-origin` (Task 3).
- SVG, XML and missing-`Content-Type` documents must receive the same sandbox CSP as HTML; CSP must not be limited to HTML (Task 3).
- Comment/location messages must be accepted for app, custom and capability-host iframe origins, and rejected for opaque/external frames (Tasks 4, 5).
- Sandbox/feature toggles must be reflected in both the iframe and the server CSP; disabled features use explicit `'none'`, and target `Permissions-Policy`/`Feature-Policy` is stripped (Tasks 3, 4, 5).

---

### Task 1: Server preview policy primitives

**Files:**
- Modify: `packages/server/src/api-types.ts`
- Create: `packages/server/src/previews/policy.ts`
- Modify: `packages/server/src/previews/manager.ts`
- Create: `packages/server/src/previews/policy.test.ts`
- Modify: `packages/server/src/previews/manager.test.ts`

**Interfaces:**
- Produces:
  - `type PreviewOriginMode = "opaque" | "app" | "custom"`
  - `interface PreviewSandboxSettings { forms: boolean; modals: boolean; popups: boolean; downloads: boolean }`
  - `interface PreviewFeatureSettings { camera: boolean; microphone: boolean; clipboardRead: boolean; clipboardWrite: boolean; geolocation: boolean; fullscreen: boolean }`
  - `interface PreviewSettings { originMode: PreviewOriginMode; customOrigin: string; sandbox: PreviewSandboxSettings; features: PreviewFeatureSettings }`
  - `const DEFAULT_PREVIEW_SETTINGS: PreviewSettings`
  - `function normalizePreviewSettings(value: unknown): PreviewSettings`
  - `function isLoopbackHostname(hostname: string): boolean`
  - `function previewDocumentSandbox(allowSameOrigin: boolean, sandbox: PreviewSandboxSettings): string`

- [ ] **Step 1: Write the failing policy tests**

Create `policy.test.ts` with exact assertions:

```ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEFAULT_PREVIEW_SETTINGS,
  isLoopbackHostname,
  normalizePreviewSettings,
  previewDocumentSandbox,
} from "./policy"

describe("preview policy", () => {
  it("accepts only literal loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "0.0.0.0", "[::1]"]) {
      assert.equal(isLoopbackHostname(host), true, host)
    }
    for (const host of ["127.evil.com", "127.0.0.1.example.com", "sub.localhost", "localhost.evil.com", "192.168.1.5"]) {
      assert.equal(isLoopbackHostname(host), false, host)
    }
  })

  it("defaults to opaque and preserves configured values", () => {
    assert.deepEqual(normalizePreviewSettings(undefined), DEFAULT_PREVIEW_SETTINGS)
    assert.deepEqual(normalizePreviewSettings({
      originMode: "custom",
      customOrigin: "https://preview.example.com",
      sandbox: { forms: false },
      features: { camera: true },
    }), {
      ...DEFAULT_PREVIEW_SETTINGS,
      originMode: "custom",
      customOrigin: "https://preview.example.com",
      sandbox: { ...DEFAULT_PREVIEW_SETTINGS.sandbox, forms: false },
      features: { ...DEFAULT_PREVIEW_SETTINGS.features, camera: true },
    })
  })

  it("rejects non-origin custom values and unknown modes", () => {
    assert.equal(normalizePreviewSettings({ originMode: "custom", customOrigin: "https://preview.example.com/path" }).customOrigin, "")
    assert.equal(normalizePreviewSettings({ originMode: "custom", customOrigin: "https://user:pass@preview.example.com" }).customOrigin, "")
    assert.equal(normalizePreviewSettings({ originMode: "unknown" }).originMode, "opaque")
    assert.equal(normalizePreviewSettings({ originMode: "custom", customOrigin: "https://preview.example.com/" }).customOrigin, "https://preview.example.com")
  })

  it("builds sandbox flags from the configured capabilities", () => {
    assert.equal(previewDocumentSandbox(false, { forms: false, modals: true, popups: false, downloads: true }),
      "sandbox allow-scripts allow-modals allow-downloads")
    assert.equal(previewDocumentSandbox(true, { forms: false, modals: true, popups: false, downloads: true }),
      "sandbox allow-scripts allow-modals allow-downloads allow-same-origin")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/server && node --import tsx --test src/previews/policy.test.ts`
Expected: FAIL because `policy.ts` and the exported symbols do not exist.

- [ ] **Step 3: Implement the types and policy helpers**

Add the shared types to `api-types.ts`; create `policy.ts` with the defaults and validators. `normalizePreviewSettings` accepts only a plain object, validates the custom origin with `new URL` and requires `url.origin === url.href` (no path/query/hash), rejects credentials, and fills every missing field from the defaults. `isLoopbackHostname` uses `node:net` `isIP(value) === 4 && value.startsWith("127.")` plus the exact `localhost`/`0.0.0.0`/`::1`/`[::1]` values.

Move the loopback predicate out of `manager.ts`; import `isLoopbackHostname` from `./policy` and keep `normalizeTargetUrl` using it. Update `manager.test.ts` to import policy helpers from `./policy` instead of `./manager`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/server && node --import tsx --test src/previews/policy.test.ts src/previews/manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api-types.ts packages/server/src/previews/policy.ts packages/server/src/previews/policy.test.ts packages/server/src/previews/manager.ts packages/server/src/previews/manager.test.ts
git commit -m "feat(preview): add normalized preview origin policy"
```

---

### Task 2: Server config normalization and origin-aware policy resolution

**Files:**
- Modify: `packages/server/src/previews/policy.ts`
- Modify: `packages/server/src/previews/manager.ts`
- Modify: `packages/server/src/settings/service.ts`
- Modify: `packages/server/src/previews/policy.test.ts`
- Modify: `packages/server/src/previews/manager.test.ts`
- Modify: `packages/server/src/settings/service.test.ts`

**Interfaces:**
- Consumes: Task 1 types and helpers.
- Produces:
  - `function resolvePreviewSettings(value: unknown, appOrigins: Iterable<string>): PreviewSettings`
  - `function previewDocumentSandboxForTarget(targetUrl: string, settings: PreviewSettings, requestHost: string): string`

- [ ] **Step 1: Write the failing tests**

Add to `policy.test.ts`:

```ts
it("never trusts an app origin as a custom origin", () => {
  assert.equal(resolvePreviewSettings(
    { originMode: "custom", customOrigin: "https://app.example.com" },
    ["https://app.example.com"],
  ).originMode, "opaque")
  assert.equal(resolvePreviewSettings(
    { originMode: "custom", customOrigin: "https://preview.example.com" },
    ["https://app.example.com"],
  ).originMode, "custom")
  assert.equal(resolvePreviewSettings(
    { originMode: "custom", customOrigin: "https://app.example.com:8443" },
    ["https://app.example.com"],
  ).originMode, "opaque")
})

it("uses the request host for custom-origin trust", () => {
  const settings = resolvePreviewSettings(
    { originMode: "custom", customOrigin: "https://preview.example.com" },
    ["https://app.example.com"],
  )
  assert.match(previewDocumentSandboxForTarget("http://127.0.0.1:3000/", settings, "preview.example.com"), /allow-same-origin/)
  assert.doesNotMatch(previewDocumentSandboxForTarget("http://127.0.0.1:3000/", settings, "app.example.com"), /allow-same-origin/)
  assert.doesNotMatch(previewDocumentSandboxForTarget("https://example.com/", settings, "preview.example.com"), /allow-same-origin/)
})

it("keeps opaque mode independent of the target and host", () => {
  assert.doesNotMatch(previewDocumentSandboxForTarget("http://localhost:3000/", DEFAULT_PREVIEW_SETTINGS, "localhost"), /allow-same-origin/)
  assert.doesNotMatch(previewDocumentSandboxForTarget("https://example.com/", DEFAULT_PREVIEW_SETTINGS, "localhost"), /allow-same-origin/)
})
```

Add a `settings/service.test.ts` case that a `server.preview` patch is normalized when read back.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/server && node --import tsx --test src/previews/policy.test.ts src/settings/service.test.ts`
Expected: FAIL because `resolvePreviewSettings` and `previewDocumentSandboxForTarget` do not exist.

- [ ] **Step 3: Implement resolution and settings normalization**

`resolvePreviewSettings` normalizes the shape, compares the normalized custom origin **hostname** against every app origin hostname (the app origin set comes from `serverMeta`), and returns the default opaque policy when the custom origin is empty, invalid or shares an app hostname. A distinct hostname is required even when a port differs. Keep the configured mode otherwise.

`previewDocumentSandboxForTarget` computes `allowSameOrigin` as:

```ts
const targetIsLoopback = isLoopbackHostname(new URL(targetUrl).hostname)
const customOriginMatches = settings.originMode === "custom"
  && settings.customOrigin.length > 0
  && hostPort(settings.customOrigin) === normalizeHostPort(requestHost)
const allowSameOrigin = settings.originMode === "app"
  ? targetIsLoopback
  : settings.originMode === "custom"
    ? targetIsLoopback && customOriginMatches
    : false
return previewDocumentSandbox(allowSameOrigin, settings.sandbox)
```

Move the target-sandbox helper from `manager.ts` into `policy.ts` (manager imports nothing from it; update `manager.test.ts` and the later `http-server.ts` import). Call `normalizePreviewSettings` from `normalizeServerConfigOwner` in `settings/service.ts` so stored `server.preview` always has the canonical shape.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/server && node --import tsx --test src/previews/policy.test.ts src/settings/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/previews/policy.ts packages/server/src/previews/manager.ts packages/server/src/previews/policy.test.ts packages/server/src/previews/manager.test.ts packages/server/src/settings/service.ts packages/server/src/settings/service.test.ts
git commit -m "feat(preview): resolve server preview policy by origin"
```

---

### Task 3: Server CSP enforcement and header sanitization

**Files:**
- Modify: `packages/server/src/server/http-server.ts`
- Modify: `packages/server/src/server/__tests__/sidecar-proxy.test.ts`

**Interfaces:**
- Consumes: `resolvePreviewSettings`, `previewDocumentSandboxForTarget`, `PreviewSettings`.
- Produces: path and fallback preview responses that carry the policy CSP; stripped `Permissions-Policy`/`Feature-Policy`; capability-host responses unchanged.

- [ ] **Step 1: Extend the test harness and add failing tests**

In `sidecar-proxy.test.ts`:
- Extend `UpstreamOptions` with `contentType?: string`, `body?: string`, `permissionsPolicy?: string`, `featurePolicy?: string`.
- Extend `startServer` with `preview?: PreviewSettings`, a settings stub whose `getOwner("config", "server")` returns `{ preview }`, and `serverMeta` with a known app origin.
- Add tests:
  - Default policy: loopback path HTML has no `allow-same-origin`.
  - App policy: loopback path HTML includes it; external helper test already covers the target tier.
  - Custom policy: `headers.host = "preview.example.com"` includes it; the same token with `headers.host = "app.example.com"` does not.
  - SVG (`image/svg+xml`), XML (`application/xml`) and missing `Content-Type` responses carry the CSP.
  - A JSON/non-document response also carries the CSP (the new all-response rule).
  - Configured sandbox flags appear exactly: e.g. `forms: false` omits `allow-forms` while `modals` remains.
  - `permissions-policy: camera=()` and `feature-policy: camera 'none'` are absent from the proxied response.
  - Capability-host responses still have no injected CSP.
  - The app-origin referer fallback uses the current policy; custom mode leaves an app-origin fallback opaque.

Also replace the existing `non-HTML path-proxied preview responses carry no sandbox CSP` assertion with the new all-response rule, and update the test import from `../../previews/manager` to the policy module for moved helpers.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/server && node --import tsx --test src/server/__tests__/sidecar-proxy.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement the proxy changes**

In `http-server.ts`:

- Add `settings: SettingsService` and `appOrigins: () => Iterable<string>` to `PreviewProxyDeps`; pass `deps.settings` and `getSelfOrigins` from `createHttpServer`.
- In `registerPreviewProxyRoutes`, resolve the policy per request from `settings.getOwner("config", "server").preview` and the app origins.
- Add `settings: PreviewSettings` to `proxyPreviewRequest` and `proxyPreviewAssetRequest`.
- Compute `documentSandbox = previewDocumentSandboxForTarget(preview.targetUrl, settings, request.headers.host ?? "")` for path and fallback requests; pass it to `proxyPreviewTargetRequest`.
- In `rewritePreviewResponseHeaders`, delete `permissions-policy`, `permissions-policy-report-only` and `feature-policy`.
- In `proxyPreviewTargetRequest`, set `next["content-security-policy"] = args.documentSandbox` whenever `args.documentSandbox` exists, independent of `responseKind`; keep the existing body rewrite and content-type handling.
- Leave the capability-host route without a `documentSandbox`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/server && node --import tsx --test src/server/__tests__/sidecar-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/http-server.ts packages/server/src/server/__tests__/sidecar-proxy.test.ts
git commit -m "feat(preview): enforce origin policy and strip target permission policy"
```

---

### Task 4: UI policy normalization and frame helpers

**Files:**
- Modify: `packages/ui/src/stores/preferences.tsx`
- Modify: `packages/ui/src/stores/preferences.test.ts`
- Modify: `packages/ui/src/components/browser-frame-security.ts`
- Modify: `packages/ui/src/components/browser-frame-security.test.ts`

**Interfaces:**
- Consumes: `PreviewSettings` from `packages/server/src/api-types.ts`; `normalizePreviewSettings` defaults.
- Produces:
  - `normalizePreviewSettings` (UI-local) and `preview` in `normalizeServerConfig`
  - `updatePreviewSettings(next: PreviewSettings): Promise<void>` on the config context
  - `validatePreviewOrigin(raw: string): string | null`
  - `previewSandboxFlags(settings: PreviewSandboxSettings): string`
  - `previewAllowAttribute(features: PreviewFeatureSettings): string`
  - `isTrustedPreviewSameOrigin(targetUrl: string, settings: PreviewSettings): boolean`
  - `getPreviewFrameSource(environment, preview, parentUrl, settings: PreviewSettings): string`
  - `isCapabilityPreviewFrame(environment, frameSource: string): boolean`
  - `getPreviewMessageOrigin(environment, frameSource, targetUrl, settings, parentOrigin): string`
  - `getBrowserFramePolicy(env, options: { trustedSameOrigin?: boolean; sandboxFlags?: string })`

- [ ] **Step 1: Write the failing UI tests**

Add tests to `browser-frame-security.test.ts` for:
- `isLoopbackHttpUrl("http://127.evil.com") === false` and `isLoopbackPreviewUrl("http://127.evil.com") === false`.
- `previewSandboxFlags` exact strings; `previewAllowAttribute` includes enabled features and `'none'` for disabled ones.
- `getPreviewFrameSource`:
  - app/opaque returns `preview.proxyUrl`;
  - custom returns `${customOrigin}${preview.proxyUrl}`;
  - desktop capability host still returns `<token>.preview.localhost`.
- `isCapabilityPreviewFrame` recognizes the desktop capability host and not app/custom path frames.
- `isTrustedPreviewSameOrigin`: opaque false, app/custom loopback true, external false.
- `getPreviewMessageOrigin`: opaque/external `"null"`, app `parentOrigin`, custom custom origin, capability-host iframe its origin.

Add `preferences.test.ts` assertions for default `preview`, custom validation, and `normalizeServerConfig` preserving preview.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ui && node --import tsx --test src/components/browser-frame-security.test.ts src/stores/preferences.test.ts`
Expected: FAIL on the new exports.

- [ ] **Step 3: Implement the UI policy helpers**

Add `preview` to `ServerConfigBucket` and `normalizeServerConfig`. Use the same defaults as the server. `normalizePreviewSettings` accepts only the documented shape; invalid custom origins become `""`; missing booleans use defaults. `validatePreviewOrigin` returns the normalized origin or `null`.

Add `updatePreviewSettings` to the config context and implementation; it calls `patchConfigOwner("server", { preview: next })`.

Implement the pure helpers in `browser-frame-security.ts`, including the strict loopback predicate and explicit `'none'` serialization. Use `sandboxFlags` in `getBrowserFramePolicy` instead of the hard-coded flags; SideCars keep the existing default when the option is omitted.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ui && node --import tsx --test src/components/browser-frame-security.test.ts src/stores/preferences.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/stores/preferences.tsx packages/ui/src/stores/preferences.test.ts packages/ui/src/components/browser-frame-security.ts packages/ui/src/components/browser-frame-security.test.ts
git commit -m "feat(preview): normalize UI preview policy and frame helpers"
```

---

### Task 5: Wire BrowserFrame and SessionPreviewView to the policy

**Files:**
- Modify: `packages/ui/src/components/browser-frame.tsx`
- Modify: `packages/ui/src/components/session-preview-view.tsx`
- Modify: `packages/ui/tests/browser/fixtures/session-preview-sandbox.tsx`
- Modify: `packages/ui/tests/browser/session-preview-sandbox.test.ts`

**Interfaces:**
- Consumes: Task 4 helpers, `useConfig().serverSettings().preview`.
- Produces:
  - `BrowserFrameProps.sandboxFlags?: string`
  - `BrowserFrameProps.allow?: string`
  - `BrowserFrameProps.expectedMessageOrigin?: string`
  - `BrowserFrameProps.policyKey?: string`

- [ ] **Step 1: Update the fixture and write the failing browser tests**

Change the fixture's `serverApi.fetchConfigOwner` to return the configured `server` preview policy (drive it from a URL query parameter such as `?mode=app|custom|opaque`) and the locale for the `ui` owner. Render the two previews as before.

Assert:
- Opaque mode: neither iframe has `allow-same-origin`.
- App mode: loopback iframe has it; external does not.
- Custom mode: loopback iframe `src` starts with the custom origin; app mode uses the path.
- A sandbox toggle (forms off) removes `allow-forms` from the iframe.
- A feature toggle (camera on) adds `camera` to the iframe `allow`; a disabled clipboard feature is serialized as `'none'`.
- A preview document that posts `codenomad-preview-location` is accepted for the matching expected origin; the same message from an opaque/external frame is ignored. Use a Vite preview document with a short script and expose the received path on the fixture root.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/ui && node --import tsx --test --test-concurrency=1 tests/browser/session-preview-sandbox.test.ts`
Expected: FAIL on the new policy behavior.

- [ ] **Step 3: Implement the wiring**

`SessionPreviewView`:
- Read `serverSettings().preview`.
- Compute the frame source with the settings.
- Determine capability-host frames and keep their isolated origin trust; otherwise use `isTrustedPreviewSameOrigin`.
- Pass `sandboxFlags`, `allow`, `expectedMessageOrigin` and a `policyKey` derived from the origin mode/custom origin/sandbox/features.
- Use a keyed `Show` or equivalent remount when `policyKey` changes so an app-to-opaque downgrade cannot leave a live same-origin document.

`BrowserFrame`:
- Extend the props.
- Use `sandboxFlags` in `getBrowserFramePolicy`.
- Set `allow={props.allow}` on the iframe.
- Compare `event.origin` with `props.expectedMessageOrigin ?? "null"` in the comment/location listener.
- Keep the existing native webview paths unchanged; the iframe `allow` and sandbox only apply to iframe previews.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/ui && node --import tsx --test --test-concurrency=1 tests/browser/session-preview-sandbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/browser-frame.tsx packages/ui/src/components/session-preview-view.tsx packages/ui/tests/browser/fixtures/session-preview-sandbox.tsx packages/ui/tests/browser/session-preview-sandbox.test.ts
git commit -m "feat(preview): apply origin and permission policy to preview frames"
```

---

### Task 6: Preview settings section, native allowlists and English strings

**Files:**
- Create: `packages/ui/src/components/settings/preview-settings-section.tsx`
- Modify: `packages/ui/src/components/settings-screen.tsx`
- Modify: `packages/ui/src/stores/settings-screen.ts`
- Modify: `packages/ui/src/lib/native/preferences-window.ts`
- Modify: `packages/electron-app/electron/main/preferences-window.ts`
- Modify: `packages/tauri-app/src-tauri/src/preferences_window.rs`
- Modify: `packages/ui/src/lib/i18n/messages/en/settings.ts`
- Modify: `packages/ui/src/lib/native-mission-preferences.test.ts` if its section-sync assertion needs the new id
- Create: `packages/ui/tests/browser/fixtures/preview-settings.tsx`
- Create: `packages/ui/tests/browser/preview-settings.test.ts`

**Interfaces:**
- Consumes: `useConfig().serverSettings`, `updatePreviewSettings`, `validatePreviewOrigin`.
- Produces: Settings section id `"preview"` and a server-scoped Preview section.

- [ ] **Step 1: Write the failing section/allowlist test**

Add the preview section to the source-sync assertion (or add a focused test) so `SettingsSectionId`, the embedded Settings nav and both native Preferences allowlists must all contain `"preview"`. Add English i18n keys in the same step; the test should fail while the component is absent.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/ui && node --import tsx --test src/lib/native-mission-preferences.test.ts`
Expected: FAIL because the section lists do not match.

- [ ] **Step 3: Implement the section and registration**

Create `PreviewSettingsSection` with four cards:

- **Origin**: select Opaque (recommended) / CodeNomad same-origin / Dedicated preview origin; custom-origin input with Save and inline validation; app-mode confirmation with the full-trust warning; current-origin and deployment contract copy.
- **Sandbox**: scripts fixed on; forms/modals/popups/downloads toggles; server/iframe enforcement note.
- **Browser features**: camera, microphone, clipboard read, clipboard write, geolocation, fullscreen; browser-still-asks caption.
- **Service workers**: read-only guidance for opaque/custom/app, including the custom `/previews` namespace limitation.

Toggles save through `updatePreviewSettings`; origin changes and the custom origin use the explicit confirmation/Save behavior. Use the existing `.settings-card`, `.settings-toggle-row`, `SettingsChoiceRow`, `SettingsInfoTip`, and selector/button styles.

Register `"preview"` in the embedded Settings nav/render, `SettingsSectionId`, the UI native Preferences allowlist, Electron `PREFERENCES_SECTIONS`, and the Tauri Rust allowlist. Add `settings.nav.preview` plus this English key set to `settings.ts` (all other locales in Task 7):
`settings.preview.title`, `settings.preview.subtitle`, `settings.preview.origin.title`, `settings.preview.origin.subtitle`, `settings.preview.origin.mode.opaque`, `settings.preview.origin.mode.app`, `settings.preview.origin.mode.custom`, `settings.preview.origin.opaqueNote`, `settings.preview.origin.appNote`, `settings.preview.origin.customNote`, `settings.preview.origin.current`, `settings.preview.origin.recommended`, `settings.preview.origin.customLabel`, `settings.preview.origin.customPlaceholder`, `settings.preview.origin.customSave`, `settings.preview.origin.customContract`, `settings.preview.origin.invalid`, `settings.preview.origin.appOriginConflict`, `settings.preview.origin.appConfirmTitle`, `settings.preview.origin.appConfirmMessage`, `settings.preview.origin.appConfirmLabel`, `settings.preview.origin.appCancelLabel`, `settings.preview.sandbox.title`, `settings.preview.sandbox.subtitle`, `settings.preview.sandbox.scripts`, `settings.preview.sandbox.scriptsNote`, `settings.preview.sandbox.forms`, `settings.preview.sandbox.modals`, `settings.preview.sandbox.popups`, `settings.preview.sandbox.downloads`, `settings.preview.features.title`, `settings.preview.features.subtitle`, `settings.preview.features.camera`, `settings.preview.features.microphone`, `settings.preview.features.clipboardRead`, `settings.preview.features.clipboardWrite`, `settings.preview.features.geolocation`, `settings.preview.features.fullscreen`, `settings.preview.features.browserNote`, `settings.preview.serviceWorkers.title`, `settings.preview.serviceWorkers.opaque`, `settings.preview.serviceWorkers.custom`, `settings.preview.serviceWorkers.app`, `settings.preview.nativeNote`, `settings.preview.saveError`.

Create a browser fixture that mounts `PreviewSettingsSection` under `ConfigProvider`/`I18nProvider` with a mocked server config. Test that the origin select, custom origin validation and a sandbox/feature toggle call the mocked patch with the expected `server.preview` object; test the app-mode confirmation appears before saving. Keep the fixture's config mock in the same shape as the real `loadConfigOwner("server")` result.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd packages/ui && node --import tsx --test src/lib/native-mission-preferences.test.ts
cd packages/ui && node --import tsx --test --test-concurrency=1 tests/browser/preview-settings.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/settings/preview-settings-section.tsx packages/ui/src/components/settings-screen.tsx packages/ui/src/stores/settings-screen.ts packages/ui/src/lib/native/preferences-window.ts packages/electron-app/electron/main/preferences-window.ts packages/tauri-app/src-tauri/src/preferences_window.rs packages/ui/src/lib/i18n/messages/en/settings.ts packages/ui/src/lib/native-mission-preferences.test.ts packages/ui/tests/browser/fixtures/preview-settings.tsx packages/ui/tests/browser/preview-settings.test.ts
git commit -m "feat(settings): add preview origin and permission settings"
```

---

### Task 7: Translations, help and developer documentation

**Files:**
- Modify: `packages/ui/src/lib/i18n/messages/{de,es,fr,he,ja,ne,ru,tr,zh-Hans}/settings.ts`
- Modify: `docs/help/{de,en,es,fr,he,ja,ne,ru,tr,zh-Hans}/browser-sidecars.md`
- Create: `dev-docs/PREVIEWS.md`
- Modify: `dev-docs/INDEX.md`
- Modify: `AGENTS.md`
- Modify: `dev-docs/SETTINGS.md`

**Interfaces:**
- Consumes: Task 6's English keys and section.
- Produces: complete locale coverage and the documented preview contract.

- [ ] **Step 1: Add all locale strings and help text**

Add every `settings.preview.*` and `settings.nav.preview` key to all nine non-English locale files using each locale's existing terminology. Update `browser-sidecars.md` in all ten locales with a section covering:

- opaque default and its limitations;
- app same-origin full-trust warning;
- custom origin's distinct-hostname, `/previews/*`, WebSocket, `Host`, TLS and header-preservation contract;
- root-relative Worker/service-worker limitation at custom origins;
- iframe-only scope versus native desktop webviews;
- sandbox toggles and browser feature delegation (browser prompts/site settings remain final).

- [ ] **Step 2: Write the developer docs**

Create `dev-docs/PREVIEWS.md` covering the token capability, three origin modes, server CSP and origin-aware custom mode, UI sandbox/allow mapping, capability-host exception, custom-origin deployment contract and comment-bridge expected origin. Add it to `dev-docs/INDEX.md` and the `AGENTS.md` Area conventions. Add the Settings → Preview conventions to `dev-docs/SETTINGS.md`.

- [ ] **Step 3: Run the documentation check**

Run: `npm run test:help`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/i18n/messages docs/help dev-docs/PREVIEWS.md dev-docs/INDEX.md AGENTS.md dev-docs/SETTINGS.md
git commit -m "docs(preview): document origin modes and permission settings"
```

---

### Task 8: Full verification and branch cleanup

**Files:**
- No production files expected; fix only failures found here.

- [ ] **Step 1: Run the server and UI unit suites**

Run:
```bash
cd packages/server && node --import tsx --test src/previews/policy.test.ts src/previews/manager.test.ts src/settings/service.test.ts src/server/__tests__/sidecar-proxy.test.ts
cd packages/ui && node --import tsx --test src/components/browser-frame-security.test.ts src/stores/preferences.test.ts src/stores/session-previews.test.ts
```
Expected: PASS.

- [ ] **Step 2: Run the affected browser fixtures**

Run:
```bash
cd packages/ui && node --import tsx --test --test-concurrency=1 tests/browser/session-preview-sandbox.test.ts tests/browser/markdown-loopback-link.test.ts
```
Expected: PASS.

- [ ] **Step 3: Run typechecks and help**

Run:
```bash
npm run typecheck --workspace @neuralnomads/codenomad
npm run typecheck --workspace @codenomad/ui
npm run test:help
```
Expected: PASS.

- [ ] **Step 4: Re-run the known flaky browser test**

Run: `cd packages/ui && node --import tsx --test --test-name-pattern="reveals survive virtualization" tests/browser/reveal-truncated-text.test.ts`
Expected: PASS. If it fails, record the failure and investigate whether this change made the existing virtualization race more likely; do not silently ignore a red CI.

- [ ] **Step 5: Review the diff and commit any fixes**

Run: `git status --short && git diff --check`
Expected: only intended files; no whitespace errors. Commit any verification fixes with a conventional message.
