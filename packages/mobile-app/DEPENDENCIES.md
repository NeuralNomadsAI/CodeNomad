# Targeted dependency remediation evidence

Scope: mission `msn_04136161b0fb739cd5a71a2c`, isolated Windows worktree only. These checks do not qualify an Android APK, iOS build, public server deployment, or store release.

## Resolved versions

| Dependency | Before | Locked after | Relevant official advisory |
|---|---|---|---|
| solid-js | 1.9.10 | 1.9.15 | Seroval chain below |
| seroval / seroval-plugins | 1.3.2 / 1.3.3 | 1.5.6 / 1.5.6 | [GHSA-mv8w-475r-vwqw](https://github.com/advisories/GHSA-mv8w-475r-vwqw), patched Seroval ≥1.5.3 |
| vite | 5.4.21 | 6.4.3 | [Windows deny bypass](https://github.com/advisories/GHSA-fx2h-pf6j-xcff), [UNC credential disclosure](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) |
| postcss | 8.5.6 | 8.5.28 | [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), patched ≥8.5.23 |
| nanoid | 3.3.11 | 3.3.19 | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8), patched 3.x ≥3.3.18 |
| browserslist | 4.28.1 | 4.29.3 | [memory growth](https://github.com/advisories/GHSA-c83g-rgw3-j3cx), [custom stats](https://github.com/advisories/GHSA-73wf-gq98-2v4g), patched ≥4.28.7 |
| baseline-browser-mapping | 2.9.11 | 2.11.27 | [GHSA-w5vr-8v7q-w6rv](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv), patched ≥2.11.0 |
| @babel/core | 7.28.5 | 7.29.7 | [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8), patched ≥7.29.6 |
| @babel/plugin-transform-modules-systemjs | 7.29.0 | 7.29.8 | [GHSA-fv7c-fp4j-7gwp](https://github.com/advisories/GHSA-fv7c-fp4j-7gwp), affects through 7.29.3 |
| rollup | 4.52.5 | 4.59.0 | [GHSA-mw96-cpmx-2vgc](https://github.com/advisories/GHSA-mw96-cpmx-2vgc) |
| workbox-build → rollup | 2.79.2 | 2.80.0 | Same advisory, separate compatible 2.x patched line |

Published versions/dependency declarations were verified against the [official npm registry](https://registry.npmjs.org/), e.g. [Solid 1.9.15](https://registry.npmjs.org/solid-js/1.9.15), [Vite 6.4.3](https://registry.npmjs.org/vite/6.4.3), and [PostCSS 8.5.28](https://registry.npmjs.org/postcss/8.5.28). Solid 1.9.15 requires Seroval and its plugins `~1.5.4`; no override forces that dependency downward. Babel packages do not all publish the same version number: this change targets the affected core/SystemJS packages, not a fabricated blanket `7.29.6` pin.

## Compatibility and change boundary

- UI/mobile declare Solid `^1.9.15`; UI/mobile/Electron declare Vite `^6.4.3` and vite-plugin-solid `^2.11.10`. No Vite 8 upgrade.
- [vite-plugin-solid 2.11.10](https://registry.npmjs.org/vite-plugin-solid/2.11.10), [electron-vite 4.0.1](https://registry.npmjs.org/electron-vite/4.0.1), and [vite-plugin-pwa 1.2.0](https://registry.npmjs.org/vite-plugin-pwa/1.2.0) accept Vite 6. Electron-vite requires Node `^20.19.0 || >=22.12.0`; checks used Node 25.2.1, and Node 24 meets the declared range.
- Root Rollup is deliberately pinned as a build dependency to **4.59.0**, and all six existing root optional native Rollup packages are aligned to **4.59.0**. This prevents an old hoisted Rollup/native ABI mismatch without forcing Workbox onto an incompatible major.
- Workbox's `^2.79.2` Rollup range resolves **2.80.0**. Its plugin-babel accepts Rollup 1/2, so no blanket Rollup-major override is used.
- Only named transitive update targets (`rollup`, `browserslist`, `@babel/core`, `@babel/plugin-transform-modules-systemjs`) were refreshed, along with their required dependency/native-platform nodes. No `npm audit fix`, forced override, Electron runtime update, Fastify migration, or unrelated feature upgrade.
- Reviewed the [Vite 6 migration guide](https://v6.vite.dev/guide/migration). Existing JS PostCSS and UI/mobile/Electron Vite configs build without a config migration. Electron main/preload CommonJS compilation was explicitly exercised.
- Native mobile Rust/Kotlin/Swift security/runtime sources, capability files, endpoint policy, SDK setup and Android workflow remain unchanged by this dependency task. Existing uncommitted changes were preserved.

## Validation and artifacts

All commands run from the isolated repository root. Logs and machine-readable reports are under the ignored `packages/mobile-app/test-results/dependency-fix/` directory:

- `audit-before.json`, `audit-after.json`: fresh full-workspace npm audits.
- `inventory-before.json`, `inventory-after.json`, `installed-tree-after.json`: installed graph/peer evidence; full `npm ls --all --json` completed without problems.
- `lock-before.json`, `lock-version-delta.json`: pre-task lock snapshot and targeted version-node delta (83 entries, including platform additions/removals and obsolete Vite-5 nested esbuild packages).
- `install-targeted.log`, `update-targeted-transitives.log`: installs used `--ignore-scripts --no-audit --no-fund`; no lifecycle scripts or global provisioning.
- `ci-reinstall.log`, `mobile-tests-after-ci.log`: a clean `npm ci --ignore-scripts --no-audit --no-fund` succeeded and all **11 mobile tests passed again**. The first bounded clean-install attempt timed out; no remaining writer was found before the successful longer retry.
- `mobile-typecheck.log`, `mobile-tests.log`: typecheck and **11 tests** passed, including the new real-bundle/import-graph regression.
- `mobile-browser-build.log`: production launcher build and browser test passed across **all ten locales**, including RTL.
- `ui-typecheck.log`, `ui-build.log`: shared UI typecheck and production/PWA build passed. Existing large-chunk warnings remain.
- `ui-auth-attachments.log`: **26 real auth-recovery/device-attachment browser regressions passed**, including hosted mobile login/no replay, drafts and native-vs-device attachments.
- `electron-typecheck.log`, `electron-js-build.log`: Electron typecheck and **main/preload/renderer JavaScript compilation** passed. The command was `npm exec --workspace @neuralnomads/codenomad-electron-app -- electron-vite build`, deliberately bypassing packaging/resource-provisioning lifecycle scripts. No native app packaging or application launch.
- `hosted-ui-artifact-inspection.json`: inspected **320 generated JS source maps / 1,584 distinct source paths**. Client Solid entry points were present; Seroval, seroval-plugins and Solid SSR modules were absent. Hosted HTML and PWA service worker were generated.

`tests/bundle.test.ts` inspects the real launcher's Rollup chunk module graph with the real production config and all ten dynamic locale chunks. It rejects Seroval/SSR modules and deserialization markers, and includes negative cases proving the guard rejects those paths. This is bundle/import evidence, not proof about every hosted-server dependency or native WebView behavior.

## Residual alerts and next gate

Full-workspace npm audit decreased **56 → 45** findings: after remediation **2 critical, 36 high, 4 moderate, 3 low**. All named targeted dependency entries above disappeared from the fresh audit. **This is not a zero-vulnerability claim.**

Residuals include critical `@fastify/reply-from` and `tar`; high Fastify/static/router/Undici chains, Electron/runtime/packaging chains, Sharp/PWA asset generation, XML parsing, glob/matching and other utilities; and Workbox/terser/serialize-javascript and AJV-related alerts. Their complete affected paths/ranges are in `audit-after.json`. They require separately reviewed remediation/compatibility work rather than unsafe major overrides. Do not infer public-server safety or store readiness from this targeted improvement.

No Android/iOS/native application build, SDK/license mutation, VM/Xcode setup, Apple account/signing operation, publication, commit, or shared-daemon operation occurred. **The existing Mac source snapshot was not modified and must be refreshed only after independent approval of these manifest/lock/test changes**, followed by independent Mac/iOS validation. Android compilation/device checks likewise remain a separate authorized gate.
