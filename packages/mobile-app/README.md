# CodeNomad mobile companion — Android-first prototype

This is a **remote client**, not the desktop Tauri host ported to a phone. A bundled, localized Solid launcher asks for the root HTTPS origin of an existing CodeNomad server. One webview navigates to that server as its **top-level document**, preserving its same-origin `HttpOnly; SameSite=Lax` sign-in cookies, SDK requests and SSE stream.

No Node, local CodeNomad backend, OpenCode executable, Git, desktop plugin, local workspace access, or TLS-verification bypass is bundled. The launcher shares UI design tokens and each UI locale's remote-access messages; it does not mount server-backed preference stores. Mobile-specific copy is in `src/messages.ts` for all ten UI locales.

## Security contract

Android transport now uses a source-owned, merged Network Security Configuration
and explicit mixed-content denial. See [Android transport policy and artifact
checks](ANDROID_TRANSPORT.md), including API 37's implicit localhost exception
and remaining device gates. Historical validation notes below are not a claim
of device-qualified delivery.

- Accept root HTTPS origins only (optional trailing `/` and explicit port). Reject userinfo, paths, query strings, fragments, whitespace/control characters, backslashes, encoded authorities, Unicode host spelling, loopback and launcher-host collisions. Use an ASCII punycode hostname for internationalized domains.
- Validate independently in JavaScript and Rust. Native commands additionally require the trusted launcher URL and main webview label. Browser input validation alone is not authority.
- The Rust navigation policy allows top-level navigation/redirects only within the selected origin; returning to the exact bundled launcher revokes remote selection. Readiness is a **side-effect-free native generation snapshot**, never endpoint selection. Rust first commits its own generation, then a serialized platform UI-thread transaction checks the native snapshot and live launcher, selects the endpoint and starts top-level loading. Native return, same-URL reload, document/webview replacement and renderer death invalidate snapshots; duplicate/stale transactions cannot overwrite a newer selection. A failed native commit rolls back only its own Rust generation.
- Android wraps Wry's native client and **rejects every non-GET main-frame request before delegating networking**, even when its initial URL is same-origin. Top-level form POST/PUT/DELETE/HEAD/etc is unsupported. This prevents a 307/308 response from preserving a POST/body while redirecting off-origin without another interception callback; `onPageStarted` recovery is not relied on as pre-request admission. Subresource fetch/XHR API POSTs remain supported: the existing server login uses `fetch('/api/auth/login', { method: 'POST' })` then `location.replace('/')`, not top-level form POST. GET redirects still use the selected-origin navigation fence. Cross-origin OAuth, external links, downloads, popup windows, HTTP downgrade and subpath deployments are unsupported. Historical Android compilation passed, but device behavior remains unverified; source/policy tests are not proof of Android network behavior.
- Before hosted modules run, native initialization sets `__CODENOMAD_RUNTIME_HOST__ = 'web'` and `__CODENOMAD_WINDOW_CONTEXT__ = 'remote'`. The actual host override name is **RUNTIME_HOST**, not HOST. Android connections fail closed unless System WebView supports `DOCUMENT_START_SCRIPT`; update System WebView if the launcher reports unsupported recovery/runtime setup. Tauri's fallback `onPageStarted` injection is not early enough for hosted startup.
- There are **zero remote native capability grants**. Only the bundled launcher gets `connect_server`. Custom-command permissions are explicitly registered in `build.rs`; the recovery plugin has no frontend permissions. Its readiness and generation-checked connection transactions are called only from Rust. Android WebView access and iOS UIKit/WKWebView checks, navigation and result resolution run on their platform UI/main thread.
- The Tauri CSP protects bundled assets; the hosted server must supply its own CSP. The origin fence protects top-level navigation, not every remote subresource. Treat the entire selected server as trusted.
- Native recovery is an Android `Button` outside the WebView / iOS `UIButton` outside WKWebView. It calls platform navigation to a hard-coded local launcher, never remote IPC, DOM, URL parameters or history. It is not a second webview. It covers ordinary server/network/TLS and JavaScript errors **while the WebView and native UI thread remain alive**. Android `onRenderProcessGone` is explicitly handled: revoke selection, detach/destroy the unusable WebView and close the Activity. **Reopen the app** after renderer death (force-stop and reopen if the resident host does not reinitialize); there is no seamless renderer-crash recovery, dead-WebView `loadUrl`, or automatic restart. A frozen UI thread, OS termination or app-process crash likewise needs operator reopening. The compact control can cover a small bottom corner of hosted content.

**Return/disconnect is not logout:** the native `↩ CodeNomad` control stops loading and returns to the launcher, clearing native remote selection. It intentionally does not clear cookies or website storage, log out, cancel running server work, or remove drafts. Sign out in the hosted UI to end authentication. Reconnect to the same server to resume. Unsaved browser-only state can be lost by navigation; server drafts/session data remain on the server. No endpoint/password is saved by the launcher. Per-server website storage can persist until app data is cleared.

## Network and deployment

The server must be reachable **from the phone** and have a valid trusted HTTPS certificate (correct hostname, full chain). `localhost` on the phone is not the development PC. Prefer a private VPN/tunnel and access-controlled HTTPS endpoint. This package deliberately does not install certificates or disable Android network security / iOS App Transport Security.

**CodeNomad's server is not yet qualified for public Internet exposure.** Review authentication lifetime/revocation, rate limiting, credentialed CORS on non-loopback binds, CSRF/origin protection, trusted reverse-proxy headers and preview isolation before public deployment. Do not expose the OpenCode daemon directly or disable CodeNomad authentication. A reverse proxy/VPN does not replace application authorization. Existing client/runtime flags are not server authorization controls.

## Development checks

See [targeted dependency remediation evidence](DEPENDENCIES.md) for locked versions, compatible peer ranges, bundle/import-graph checks and remaining workspace audit alerts. Frozen Mac snapshots remain preserved; GitHub integration is not a refresh or qualification of those snapshots.

From the repository root:

```text
npm ci --ignore-scripts
npm run build:mobile
npm run typecheck:mobile
npm run test:mobile
npm run test:browser --workspace @codenomad/mobile-app
npm run rust:policy --workspace @codenomad/mobile-app
npm run rust:fmt --workspace @codenomad/mobile-app
npm run rust:check --workspace @codenomad/mobile-app
```

The policy crate runs URL/authority/redirect tests without building a webview. The full Rust check on Windows validates the shared host but **does not compile Kotlin/Swift or validate a phone**. Tauri/CLI are pinned to 2.12.1 with a separate Cargo lockfile; checks used Rust 1.94.0. The Tauri CLI is workspace-local. No global CLI installation is needed.

Desktop compilation is for validation only; desktop connections deliberately fail readiness because this package provides recovery chrome only on mobile. Continue using the existing Electron/Tauri desktop hosts for desktop use. npm currently deduplicates the mobile CLI 2.12.1 into the existing desktop workspace's compatible `^2.9.4` range; this changes the root npm lockfile's CLI resolution, not desktop source or its Cargo lockfile.

The isolated launcher browser test needs Playwright Chromium (`CODENOMAD_BROWSER_PATH` may select an existing executable). It exercises the real production Solid bundle with only native invoke mocked, checks all ten locales/RTL at phone width, and captures `test-results/`. It is not an Android/iOS webview test. Rebuild icons after changing `src-tauri/icon.svg` with `npm run tauri --workspace @codenomad/mobile-app -- icon src-tauri/icon.svg --output src-tauri/icons`.

`tests/native/ConnectionAuthorityTest.kt` exercises the **production pure-JVM Android authority** (not a copied policy): side-effect-free readiness, competing selections, immediate return, same-URL document replacement, different WebView identities, renderer revocation and initial non-GET denial for 307/308 chains, while preserving fetch POST plus GET login navigation. With an already installed Kotlin compiler/JDK, from `packages/mobile-app`:

```text
kotlinc src-tauri/recovery/android/src/main/java/ai/neuralnomads/codenomad/recovery/ConnectionAuthority.kt tests/native/ConnectionAuthorityTest.kt -include-runtime -d test-results/authority-tests.jar
java -jar test-results/authority-tests.jar
```

Create `test-results` if absent. No compiler/SDK is auto-installed by these checks. These JVM tests still do not exercise real WebView callbacks or networking; JavaScript contract tests check that the native adapter consults this production gate before delegating requests. Windows Rust tests cover generation rollback, duplicate admission and authority/redirect fencing. The standalone Kotlin test has not yet been compiled/run here.

## Android prerequisites and artifacts

Install/configure these explicitly outside this package (no automatic SDK installation or license acceptance):

- Rust and an appropriate Android Rust target. ARM64 scripts require `rustup target add aarch64-linux-android`.
- Android Studio or equivalent command-line SDK setup; suitable JDK (Android Studio's bundled JBR is the official Tauri recommendation). The CI workflow uses Temurin **JDK 17**, the documented minimum for the generated Android Gradle Plugin 9.3.
- Android SDK Platform **37.0** (CLI 2.12.1's generated app targets API 37) and **36** (the recovery library compile SDK), Platform-Tools, Build-Tools, Command-line Tools, and side-by-side NDK. CI explicitly selects Build-Tools **36.0.0**, command-line tools **16.0 / build 12266719**, and NDK **28.2.13676358**. Prefer **NDK 28+** for Android 16 KiB page alignment.
- `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME` pointing to real installations; accepted SDK licenses under the operator's control.
- `adb` and USB debugging / authorized device, or a configured emulator, for installation and actual device testing. `adb` is not required merely to produce a build artifact.

Minimum Android API is **26 (Android 8.0)** because the recovery/navigation adapter uses `WebView.getWebViewClient()` to preserve Wry's existing client; core Tauri alone supports API 24. A current System WebView with document-start-script support is also required. Initial scripts intentionally build only ARM64; add matching Rust targets and change CLI targets to test x86_64 emulators or other architectures.

```text
npm run android:init --workspace @codenomad/mobile-app
npm run android:debug --workspace @codenomad/mobile-app
npm run android:release --workspace @codenomad/mobile-app
npm run android:bundle --workspace @codenomad/mobile-app
```

Init creates `src-tauri/gen/android`; Gradle downloads/builds may require Internet access. The launcher is built automatically by Tauri's `beforeBuildCommand`. Inspect `src-tauri/gen/android/app/build/outputs/apk/` for the debug APK. Typical AAB location is `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`; exact APK variant paths depend on generated Gradle configuration.

Debug APK uses development signing. **Release scripts do not provision signing secrets:** configure the generated Gradle release signing config and private `keystore.properties` per the official guide before distributing. Never commit keystores/passwords. Use the same signing identity for updates. Google Play requires a developer account and signed AAB; this prototype has not passed store review.

Verify on a real device: launcher localization/RTL and large text; fetch-based sign-in/cookie persistence; SSE/reconnect; network/TLS failures; same-origin and cross-origin GET redirects; same-origin form POST returning 307/308 off-origin (neither initial nor target server may receive that top-level POST); remote native-invoke denial; competing native connection requests interleaved with return/reload; native return while loading/offline; renderer termination followed by Activity close and explicit reopening (never reuse the destroyed WebView); keyboard, gesture navigation, rotation/insets; process restart; and drafts before/after returning. Verify multiwindow/popup behavior because Tauri's Rust `on_new_window` callback is **not supported on Android/iOS**; Android settings disable automatic/multiple windows, but these are not a substitute for device verification.

### Pull-request validation and consent-gated GitHub Actions debug APK

Workflow source: [`.github/workflows/mobile-android.yml`](../../.github/workflows/mobile-android.yml). Relevant PRs (including forks) run **Launcher, source contracts and Rust policy (not a native APK)** without accepting SDK licenses. Paths cover the companion/workflow, root lock/configuration, workspace manifests, shared launcher tokens/locales and the login-page source contract. It installs locked npm dependencies with `npm ci --ignore-scripts`, runs launcher typecheck/unit tests, verifies the source-owned Tauri ABI override/receipts, builds/tests the production launcher across all ten locales, and runs locked Rust URL/authority policy tests. Java 17 enables the production Android XML check; these are source/browser/policy results, **not Kotlin/Swift compilation or phone behavior**.

The separate **ARM64 debug APK (explicit SDK license consent required)** job runs only after source validation passes and an authorized maintainer explicitly consents:

- **PR builds:** set the repository Actions variable `CODENOMAD_ANDROID_ACCEPT_SDK_LICENSES` to `true`, only with authority to accept Android SDK licenses on disposable CI runners (GitHub string comparisons are case-insensitive). This authorizes SDK setup for every relevant PR, including fork code; standard GitHub fork-workflow approvals still apply. Missing/false/other values leave the job **skipped**, and the run summary explicitly says no APK was built. Maintainers must inspect this job, not infer APK success from a green source check. This change does not set the variable or alter repository security settings.
- **Manual builds:** once the workflow is on the default branch, an operator with write access can open [Actions → Mobile Android validation and debug APK](https://github.com/NeuralNomadsAI/CodeNomad/actions/workflows/mobile-android.yml), select **Run workflow**, choose the companion branch, and confirm the SDK-license checkbox **only if authorized**. An unchecked box skips the APK job even if the PR consent variable is enabled; source validation still runs.

Both jobs use disposable `windows-2022` runners with Node 24, Java 17 and Rust 1.94.0. The APK job additionally installs `aarch64-linux-android` and the explicit SDK/NDK packages above. Windows avoids Linux GTK/WebKit desktop prerequisites. SDK setup accepts licenses **on that CI runner only** after the gate; nothing here installs or accepts licenses on a developer machine. External actions are pinned to official upstream commit SHAs. Checkout uses `github.sha` (the PR merge commit for PRs) without persisted credentials. The workflow uses only `contents: read`, no secrets, privileged PR trigger, shared build cache, release/upload-to-store or production signing credentials. Its actual native build commands are:

```text
npm run android:init --workspace @codenomad/mobile-app -- --ci --skip-targets-install
npm run android:debug --workspace @codenomad/mobile-app -- --ci
```

The existing debug script supplies `--debug --apk --target aarch64`; `--ci` disables prompting and `--skip-targets-install` avoids initializing unrelated Rust architectures. Tauri builds the launcher again through `beforeBuildCommand`. The workflow fails if it cannot find a debug APK under the generated Gradle APK output directory, creates `SHA256SUMS.txt` and commit/build metadata, then uploads **only APK(s) and those text files** as `codenomad-android-debug-arm64-<run-id>-<attempt>` with seven-day retention. Download the artifact from the successful run's **Artifacts** section and extract its ZIP. For a downloaded APK, `Get-FileHash .\<apk-name>.apk -Algorithm SHA256` should match its entry in `SHA256SUMS.txt`.

This is a development-signed, debuggable **ARM64 test artifact**, not a GitHub Release, Play Store upload, AAB, or production-signed application. No signing secrets are used; ephemeral debug signing keys may differ between runs, so an existing installation may need removal before installing another run's APK (removal clears app-local data). Only install artifacts from a trusted repository/run. On an authorized ARM64 device with USB debugging, use `adb install .\<apk-name>.apk` and complete the real-device checklist above. Android 8/API 26 plus updated System WebView is required; this APK is not intended for x86_64 emulators.

**The PR workflow and consent-gated build have not been executed on GitHub during local validation.** The runnable workflow contract check (`npm run test:mobile`) covers immutable action refs, read-only credentials, source/native separation and the real consent expression (including false/missing values and manual-vs-PR isolation). Local YAML/PowerShell checks do not verify runner package availability, generated SDK/Gradle compatibility, Kotlin compilation, native linking or actual APK output; those remain unverified until a successful remote APK job. The mobile-only Cargo patch and native pre-link ABI guards are preserved, not bypassed by CI. Even a successful build does not verify on-device authentication, navigation fencing or recovery. Review workflow/toolchain changes when updating the pinned CLI; no generated Gradle/source edits or compatibility bypasses are applied by this workflow.

References: [manual dispatch prerequisites](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow), [downloading artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts), [SDK setup action and license behavior](https://github.com/android-actions/setup-android/tree/v3), [AGP 9.3 compatibility/JDK 17](https://developer.android.com/build/releases/agp-9-3-0-release-notes), and [pinned CLI Android template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-cli/templates/mobile/android/app/build.gradle.kts).

## iOS — native component checks and future app build

See [the stopped-experimentation state and Shantur handoff](IOS_HANDOFF.md).
The iOS PR workflow validates source only on Linux; it does not build an iOS app.

The app and Swift recovery package require **iOS 15.0 or newer**. Real SwiftRs/Tauri/Recovery modules and objects were compiled for Intel simulator and ARM64 device targets with SDK 26.2; this is **not an iOS application link or native FFI execution pass**. See [the source-owned Tauri C ABI correction, dependency pins and evidence](IOS_ABI.md). Local native iOS experimentation is stopped. The following commands describe future tooling, not an instruction to resume: agree a supported unsigned build contract first. The current `ios:build` requests distribution export and must not be used for default validation. A supported Mac with full Xcode (not just Command Line Tools), CocoaPods, Rust, Node/npm, and iOS Rust targets is required:

```text
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
npm run ios:init --workspace @codenomad/mobile-app
npm run ios:build --workspace @codenomad/mobile-app
```

The Swift package's `../.tauri/tauri-api` dependency is wired by Tauri's mobile tooling. Distribution requires Apple Developer enrollment, matching bundle ID, signing certificate and provisioning profile (automatic Xcode signing or protected CI secrets). The script requests `app-store-connect` export; configure signing first. Expected IPA output: `src-tauri/gen/apple/build/arm64/CodeNomad Mobile.ipa` (confirm generated product name/path). Simulator builds are not distributable device IPAs. Test safe-area overlay attachment, accessibility, navigation fencing and recovery on the Mac/device before claiming iOS readiness. No Windows cross-compilation workaround is supplied.

## Official references

- https://v2.tauri.app/start/prerequisites/
- https://v2.tauri.app/start/project-structure/
- https://v2.tauri.app/develop/plugins/develop-mobile/
- https://v2.tauri.app/security/capabilities/
- https://v2.tauri.app/security/csp/
- https://v2.tauri.app/distribute/google-play/
- https://v2.tauri.app/distribute/sign/android/
- https://v2.tauri.app/distribute/app-store/
- https://v2.tauri.app/distribute/sign/ios/
- https://developer.android.com/reference/android/webkit/WebView#getWebViewClient()
- https://developer.android.com/reference/android/webkit/WebViewClient#shouldOverrideUrlLoading(android.webkit.WebView,%20android.webkit.WebResourceRequest)
- https://developer.android.com/reference/androidx/webkit/WebViewCompat#addDocumentStartJavaScript(android.webkit.WebView,java.lang.String,java.util.Set%3Cjava.lang.String%3E)
- https://developer.android.com/reference/android/webkit/WebViewClient#shouldInterceptRequest(android.webkit.WebView,android.webkit.WebResourceRequest)
- https://developer.android.com/reference/android/webkit/WebViewClient#onRenderProcessGone(android.webkit.WebView,android.webkit.RenderProcessGoneDetail)

Historical isolated Windows builds produced an ARM64 debug APK with source-owned transport hardening (SHA256 `c316a46a1ee42c2106dc85384f7e9b68ae54cfe80517bc1e9bea57201ad82bdd`). It remains uninstalled and device-unvalidated; no emulator was booted. No iOS app/IPA or store-ready distribution exists. These retained local artifacts are not GitHub CI build evidence.
