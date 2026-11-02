# iOS source preparation — handoff to Shantur

**Preparation only, not a delivered or device-qualified mobile application.**
Local iOS experimentation is stopped. This handoff does not authorize another
Mac/VM/SSH, runtime download, resolver, sandbox or diagnostic attempt.

## What exists / what does not

- The common Android/iOS companion is a bundled launcher plus one top-level
  **HTTPS server-hosted UI**, not a mobile desktop backend. No Node/OpenCode/Git
  runs on the phone, no remote native IPC capability is granted, and there is no
  TLS bypass. Native endpoint/navigation/recovery authority must remain separate
  from hosted DOM. Return is not logout: cookies/storage may persist; it does not
  cancel server work or guarantee preservation of unsaved browser-only drafts.
- Source contracts, launcher typecheck/build and pure URL/authority tests exist.
  Android debug artifacts remain **uninstalled/device-unvalidated** in this
  handoff; a successful debug build is not mobile acceptance or store readiness.
- Historical SDK **26.2**, Swift language mode **5** compilation produced genuine
  SwiftRs/Tauri/Recovery modules and objects for ARM64 iOS 15 device and Intel
  iOS 15 simulator targets. Corrected and original-source LLVM IR controls were
  checked. **Object compilation is not a linked application or executed FFI.**
- The separate mobile Cargo workspace vendors **Tauri 2.12.1** with a corrected
  `Int32` request ID and `(Int32, Int32, CChar pointer)` callback ABI matching
  Rust `i32`/C `int`. Preserve `ios:verify`, the vendored pre-link hash/version
  guard, the app's owned `DEP_TAURI_IOS_LIBRARY_PATH` check, licenses, receipts,
  exact Cargo lock and SwiftRs commit pin. See [IOS_ABI.md](IOS_ABI.md).
- FFI ID extremes, success/reject paths, async ownership/retain/Drop and
  autorelease-pool lifetimes remain **unqualified**. SwiftRs Array escaped-pointer
  warnings are real and unresolved; the command ABI fix does not fix them.
- No simulator runtime **26.2 / 23C54 Universal** is installed. No generated
  Xcode app project, linked `.app`, IPA or native WKWebView execution is proven.
  Complete locked native dependency resolution also remains outstanding.

## Stopped attempts and evidence

The two authorized Apple transport attempts were consumed; **no third
attempt** is authorized. An observed sandbox `SIGABRT` has an **unknown cause**;
do not infer a fix or broaden/repeat the profile. Required confinement of the
native Swift/linker cache has not been demonstrated. These are open gates, not
reasons to disable containment or use shared/global caches.

Portable provenance is in `IOS_ABI.md` and the committed vendor receipts:
`tauri-2.12.1-upstream.json`, `tauri-2.12.1-local.json`,
`tauri-2.12.1-codenomad.patch` and `codenomad-ios-abi.sha256`.
The patch SHA256 is
`7416bbd978eb088706ad61439b5ac06a2632512c13aa7ebb4794c4138c9f300e`.
Historical successful component evidence is named `RESULT-r2.json` and
`SWIFTPM-PIN-r3.json`; private transport/crash/cache receipts remain with the
coordinator. They are not CI artifacts. Do not publish raw crashes, download
ledgers, credentials, machine paths or guest network identifiers.

## Source-only CI and reproducible source checks

[mobile-ios.yml](../../.github/workflows/mobile-ios.yml) runs on scoped pull
requests or manual dispatch on Linux: locked workspace npm installation with
scripts disabled, source tests/typecheck, bundled launcher build, ABI receipt
verification and locked pure Rust policy tests. It does not compile Tauri/GTK,
Swift or an iOS application, install Apple tooling, sign, export or upload a
binary. Actions are pinned to immutable commits and permissions are read-only;
no signing/account secrets are used. npm/Rust dependency acquisition in CI is
not an Apple download or a claim of a fully offline runner.

From the repository root with existing dependencies/toolchain:

```sh
npm run typecheck --workspace @codenomad/mobile-app
npm run test --workspace @codenomad/mobile-app
npm run build --workspace @codenomad/mobile-app
npm run ios:verify --workspace @codenomad/mobile-app
cargo test --offline --locked --manifest-path packages/mobile-app/src-tauri/policy/Cargo.toml
```

Preparation source checks passed locally: **19 JavaScript tests passed**, one
existing JDK-dependent Android XML test skipped at that stage. Latest-dev
Android integration subsequently passed **19/19 without a JDK skip**; the added
iOS workflow guard is checked separately during handoff integration.
Typecheck, launcher build and the verifier's **142 upstream files / 13 native guard inputs** passed. Pure Rust
policy tests passed **4/4**. The local explicit `+1.94.0` invocation unexpectedly
auto-installed that Rust toolchain: Cargo's `--offline` does **not** disable
rustup acquisition. Use an already installed toolchain for further local source
checks; do not treat these results as a fully offline toolchain setup.

Local source checks and historical compiler receipts are separate from GitHub
execution. **This iOS workflow has not run on GitHub during preparation.** Its
static contract regression is `tests/ios-workflow.test.ts`. No native iOS local
test is requested by the commands above. A CI pass cannot clear native gates.

## Shantur's next gates (in order, with fresh operator approval)

1. Review source, security contracts, dependency receipts and CI results first.
   Review [README.md](README.md), [IOS_ABI.md](IOS_ABI.md),
   [DEPENDENCIES.md](DEPENDENCIES.md) and
   [mobile delivery gates](../../dev-docs/MOBILE_DELIVERY.md). The server remains
   **undeployed and not approved for public Internet exposure**. Preview
   containment uses reply-from's locked Undici **5.29.0** with `pipelining: 0`;
   that narrow mitigation is not general server security approval. The retained
   workspace audit records **45 findings** (2 critical, 36 high, 4 moderate,
   3 low), not a fresh audit or a zero-vulnerability claim. Authentication,
   origin/CSRF, rate limiting, proxy trust and preview isolation still need review.
2. Prefer a **supported, owned real Mac/device builder** with full Xcode,
   CocoaPods, compatible Node/Rust and iOS targets, approved toolchain/license
   provenance and adequate resources. Agree an **unsigned/non-distribution build
   contract** and process-local toolchain/cache/output isolation before native
   work; preserve ABI guards and fail closed if confinement cannot be met.
   This is not permission to resume the exhausted experimental route.
   **Do not run the current `ios:build` script as a default validation command:**
   it requests `--export-method app-store-connect`. Agree a separate supported
   unsigned build invocation first; no production export or signing by default.
3. Prove the exact locked native graph, generated-project wiring and app link;
   then run real Rust→Tauri→Recovery FFI tests (ID extremes, success/reject,
   async/pool-drain lifetimes and escaped pointers). Component compilation alone
   cannot clear this gate.
4. On an authorized real device, qualify WKWebView login/cookie/SSE behavior,
   trusted/invalid TLS, same-origin and off-origin navigation/redirects/popups,
   remote IPC denial, document-start host flags, native return/recovery during
   load/offline, keyboard/safe areas/accessibility/RTL, reload/background/resume,
   renderer/process death and explicit reopening. Preserve drafts without
   replaying failed mutations; return/disconnect must not masquerade as logout.
5. Treat signing, Apple accounts, provisioning, export and store submission as
   **separate explicit operator authorizations**. Nothing here publishes to a
   store. Assess App Review Guideline **4.2 (minimum functionality)**: a hosted
   web wrapper may not provide sufficient utility for acceptance. Review policy
   at submission time; do not promise approval.
